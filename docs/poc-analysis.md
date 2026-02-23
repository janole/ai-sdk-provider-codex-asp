# PoC Analysis: @janole/ai-sdk-provider-codex-asp

_Compared against the working implementation in `@janole/chat-server/packages/ai-tools/codex/`._

---

## 1. What We Built

`@janole/ai-sdk-provider-codex-asp` is a **Vercel AI SDK v3 provider** (`LanguageModelV3`) that speaks
the Codex App Server JSON-RPC protocol. Any app that already uses `generateText()` / `streamText()`
from the `ai` package can drop it in with zero changes to its AI layer.

```
┌─────────────────────────────────────────────────────────┐
│  Vercel AI SDK  (generateText / streamText)             │
├─────────────────────────────────────────────────────────┤
│  CodexLanguageModel  (LanguageModelV3)                  │
│   doGenerate()  ──────────────────────────┐             │
│   doStream()  ─────────────────────────┐  │ (aggregates)│
├────────────────────────────────────────┼──┴─────────────┤
│  AppServerClient  (JSON-RPC 2.0)       │                │
│   request / notification / onRequest   │                │
├────────────────────────────────────────┼────────────────┤
│  Transport layer                       │                │
│   StdioTransport  │ WebSocketTransport │                │
└───────────────────┴────────────────────┴────────────────┘
         │ stdin/stdout or WebSocket
         ▼
    codex app-server
```

### Components

| File | Responsibility |
|------|---------------|
| `provider.ts` | `createCodexAppServer()` factory; freezes resolved settings |
| `model.ts` | `CodexLanguageModel` — `doStream()` + `doGenerate()` |
| `client/app-server-client.ts` | JSON-RPC 2.0 — requests, notifications, inbound request handling |
| `client/transport-stdio.ts` | Spawns `codex app-server --listen stdio://`, line-buffered I/O |
| `client/transport-websocket.ts` | Connects to a WS endpoint |
| `protocol/event-mapper.ts` | Codex notifications → `LanguageModelV3StreamPart` |
| `protocol/prompt-mapper.ts` | `LanguageModelV3Prompt` → `CodexTurnInputItem[]` |
| `protocol/types.ts` | Hand-maintained protocol type subset (see §6) |
| `dynamic-tools.ts` | `DynamicToolsDispatcher` — inbound tool call routing + timeout |

---

## 2. End-to-End Call Flow (`doStream`)

Every `doStream()` call creates a **fresh, short-lived connection** to Codex:

```
doStream()
  │
  ├─ new Transport (stdio/ws/custom)
  ├─ new AppServerClient(transport)
  ├─ new CodexEventMapper()
  │
  └─ ReadableStream {
       start(controller) {
         client.connect()                       // transport open
         dispatcher.attach(client)             // register tool call handler (if experimentalApi)
         client.onAnyNotification → mapper.map() → controller.enqueue()
         client.request("initialize", params)
         client.notification("initialized")
         client.request("thread/start", {model, dynamicTools, cwd, approvalPolicy, sandbox})
           → threadId
         client.request("turn/start", {threadId, input: mapPromptToTurnInput(prompt)})
           → turnId
         // stream runs until mapper sees turn/completed → controller.close()
       }
       cancel() { client.disconnect() }
     }
```

### Protocol Message Sequence

```
→ initialize          {clientInfo, capabilities: {experimentalApi}}
← {threadId: ...}    (initialize response)
→ initialized         (notification, no id)

→ thread/start        {model, dynamicTools[], approvalPolicy, sandbox, cwd}
← {thread: {id}}     (thread/start response)

→ turn/start          {threadId, input: [{type:"text", text, text_elements:[]}]}
← {turn: {id}}       (turn/start response)

← turn/started        (notification)
← item/started        {itemId, itemType:"assistantMessage"}
← item/agentMessage/delta  {itemId, delta:"..."}
  ...
← item/completed      {itemId}
←→ item/tool/call     {callId, tool, arguments}   ← bidirectional RPC: Codex requests, we respond
→ {id, result: {contentItems, success}}
  ...
← turn/completed      {status:"completed"}
```

### Stream Part Mapping

| Codex notification | AI SDK stream part |
|---|---|
| `turn/started` | `stream-start` (once, `warnings: []`) |
| `item/started` (assistantMessage) | `text-start {id: itemId}` |
| `item/agentMessage/delta` | `text-delta {id: itemId, delta}` |
| `item/completed` (assistantMessage) | `text-end {id: itemId}` |
| `item/tool/callStarted` | `tool-input-start {toolCallId: callId, toolName, dynamic: true}` |
| `item/tool/callDelta` | `tool-input-delta {toolCallId: callId, delta}` |
| `item/tool/callFinished` | `tool-input-end {toolCallId: callId}` |
| `turn/completed` | `text-end` (all open) + `finish {finishReason, usage}` |

Finish reason mapping: `completed → stop`, `failed → error`, `interrupted → other`.

---

## 3. Dynamic Tools

The `DynamicToolsDispatcher` handles inbound `item/tool/call` RPC requests from Codex:

```
Provider settings:
  tools: {
    myTool: {
      description: "...",       ← advertised to Codex in thread/start
      inputSchema: {...},       ← JSON Schema, advertised to Codex in thread/start
      execute: (args, ctx) => Promise<CodexToolCallResult>
    }
  }

At thread/start: dynamicTools = [{name, description, inputSchema}, ...]
At runtime:      Codex → item/tool/call → dispatcher.dispatch() → execute() → response
```

Timeout is enforced per call (`toolTimeoutMs`, default 30 s). On error or timeout, a
`{success: false, contentItems: [{type:"inputText", text: message}]}` is returned so Codex
can continue rather than hang.

Legacy `toolHandlers` (handler function only, no schema) still work but the tools are not
advertised to Codex in `thread/start` and Codex therefore will not call them autonomously.

---

## 4. Architectural Comparison with chat-server

The two implementations serve very different purposes and operate at different layers.

### chat-server: Daemon + Worker pool

```
┌─────────────────────────────────────────────────────┐
│  Next.js / User Agent                               │
│   generateText({tools: {codexRun, ...}})            │
├─────────────────────────────────────────────────────┤
│  CodexDaemon  (singleton)                           │
│   Worker pool  [W1] [W2] ...  (CODEX_POOL_SIZE=2)   │
│   WorkspaceManager  (git clones, state machine)     │
├─────────────────────────────────────────────────────┤
│  CodexWorker  (one process per worker, persistent)  │
│   JSON-RPC over stdin/stdout (line-delimited)       │
│   Approval interrupt/resume state machine           │
│   Tool call routing → codex-document-tools          │
├─────────────────────────────────────────────────────┤
│  codex app-server  (long-lived process per worker)  │
└─────────────────────────────────────────────────────┘
```

### Key differences

| Aspect | @janole/ai-sdk-provider-codex-asp | chat-server daemon |
|---|---|---|
| **Codex process** | Spawned per request, dies after turn | Long-lived, reused across turns |
| **Threading** | Stateless — new thread every call | Persistent — resumes threads across requests |
| **Transport** | Stdio or WebSocket | Stdio only |
| **Approval flow** | Not implemented | Full interrupt/resume with token-based state |
| **Workspace** | Not managed | Full lifecycle: clone → ready → idle → broken |
| **Tool delegation** | Local `execute()` functions | Delegates to Supabase-backed document/task system |
| **Error output** | Thrown to caller as stream error | Accumulated as text, returned as string |
| **Reasoning** | Not exposed in stream parts | Passed as `effort`/`summary` turn params |
| **Sandbox policy** | `SandboxMode` string | Full `SandboxPolicy` object (externalSandbox + network) |
| **Turn input** | Text only (POC prompt mapper) | Text only too — but richer params (effort, summary, model override) |
| **Lifetime** | Ephemeral (transient SDK call) | Persistent daemon, survives request boundaries |

### What chat-server does that we don't

**Thread resumption.** The daemon stores `threadId` in a workspace and passes it back to Codex
via `thread/resume`. We start a fresh thread every call. This means the LLM has no memory of
previous turns by default.

**Approval interrupt/resume.** When Codex requests command or file-change approval,
the daemon pauses the current turn, stores a pending-approval token, notifies the caller,
and later resumes via a second `enqueue()` call with the approval response. We have no
equivalent mechanism — approval events are not surfaced in the stream at all.

**Rich sandbox policy.** chat-server sends `{type: "externalSandbox", networkAccess: "enabled"}`
(a full `SandboxPolicy` object). We send only the simple `SandboxMode` string.
Per the generated `ThreadStartParams`, the field is `sandbox?: SandboxMode` — a string enum —
so both are valid, but the richer policy object gives Codex more context.

**Reasoning control.** `turn/start` supports `effort` (`ReasoningEffort`) and `summary`
(`ReasoningSummary`). We pass neither; Codex uses its defaults.

**Worker pool / load balancing.** One Codex process per worker, reused across turns.
We spawn a new process per `doStream()` call, which carries process start-up cost on every request.

---

## 5. Gaps and TODOs

### Prompt Mapper (significant gap)

`mapPromptToTurnInput` is a minimal POC. It:
- Flattens all roles (system, user) into a single text blob joined with `\n\n`
- Ignores assistant messages, tool results, images
- Returns a single `{type:"text"}` item with empty `text_elements`

A proper implementation would:
- Map each user message turn separately as a distinct turn input item
- Extract `mentions` / `skills` from text and populate `text_elements`
- Handle image parts → `{type:"image", url}` or `{type:"localImage", path}`
- Surface system instructions via `baseInstructions` / `developerInstructions` in `thread/start`

### Token Usage

All token counts are `undefined`. The Codex protocol emits token usage somewhere
(likely as a notification or in the `turn/completed` payload); we don't yet map it.

### Reasoning Stream Parts

The AI SDK v3 has `reasoning-start`, `reasoning-delta`, `reasoning-end` stream parts.
Codex emits `item/agentMessage/delta` for reasoning content too (via `AgentReasoningDeltaNotification`
in the generated types). Not yet mapped.

### File Change Notifications

Codex emits `item/started` / `item/completed` for `fileChange` item types.
These aren't surfaced in the stream. Relevant for coding use-cases.

### Per-call vs Persistent Connection

Each `doStream()` call goes through `initialize → thread/start → turn/start`.
That's three sequential round-trips before the first token arrives.
For WebSocket transport, persisting the connection and reusing threads across calls
would significantly reduce latency.

### `description` Optional in `CodexDynamicToolDefinition`

The generated `DynamicToolSpec` has `description: string` (required).
Our hand-maintained type has `description?: string` (optional).
Codex may silently drop or mishandle tools with no description.

### No `experimentalRawEvents` / `persistExtendedHistory`

The generated `ThreadStartParams` has two required boolean fields:
`experimentalRawEvents` and `persistExtendedHistory`. We omit them entirely —
they likely default to `false` server-side, but this is untested.

### `CodexTurnInputText.text_elements` Type

Our hand-maintained `text_elements` uses `{start, end, type: "mention"|"skill"}`.
The generated `TextElement` type may have a different shape. Worth pinning and checking.

---

## 6. Protocol Types: Hand-maintained vs Pinned Generated

`src/protocol/types.ts` is the hand-maintained subset. Two simple enum types are
**pinned generated files** (force-added to git, gitignore overridden):

| File | Status |
|---|---|
| `src/protocol/app-server-protocol/v2/AskForApproval.ts` | Pinned generated |
| `src/protocol/app-server-protocol/v2/SandboxMode.ts` | Pinned generated |
| Everything else in `types.ts` | Hand-maintained |

Run `npm run codex:generate-types` to regenerate the full set locally
(`src/protocol/app-server-protocol/` — gitignored, 240+ files).
Use it as a reference when adding new types or checking for field name drift.

**Known drift already corrected:**
- `approvalMode` → `approvalPolicy` (thread/start param)
- `sandboxMode` → `sandbox` (thread/start param)
- `"full-access"` → `"danger-full-access"` (SandboxMode value)
- `inputSchema: JSONValue` → `inputSchema: Record<string, unknown>` (DynamicToolDefinition)

---

## 7. What Works Well

- **Clean layering.** Transport / JSON-RPC client / model / event mapper are properly separated.
  Adding a new transport (e.g., Unix socket) requires only implementing `CodexTransport`.

- **Bidirectional RPC.** `AppServerClient` correctly handles both outbound requests and
  inbound requests from Codex (tool calls). Most JSON-RPC client libraries only do one direction.

- **Tool timeout.** `withTimeout()` in `DynamicToolsDispatcher` ensures a stuck handler
  can't block a turn indefinitely.

- **AbortSignal wiring.** `options.abortSignal` is correctly connected to stream cancellation.

- **`doGenerate` via `doStream`.** Rather than a separate implementation, `doGenerate` consumes
  the stream internally. One code path to maintain.

- **Generated types as ground truth.** The `codex:generate-types` workflow + selective
  `git add -f` gives a principled way to track protocol drift without committing 240 files.

---

## 8. Suggested Next Steps

1. **Persist transport / thread across turns** — hold a connection open and reuse `threadId`
   for multi-turn conversations (maps to the `thread/resume` RPC).

2. **Improve prompt mapper** — at minimum, keep roles separate; ideally extract mentions/skills.

3. **Surface `baseInstructions` / `developerInstructions`** — pass system messages through
   `thread/start` rather than folding them into the user turn text.

4. **Map token usage** — find where the protocol sends token counts and wire into the `finish` part.

5. **Map reasoning parts** — `AgentReasoningDeltaNotification` → `reasoning-delta`.

6. **Add `effort` / `summary` to `turn/start`** — expose reasoning effort as provider or
   per-call settings.

7. **Pin `TextElement` and `TurnStartParams`** — force-add these generated files to avoid
   silent schema drift on `text_elements` and missing required fields.

8. **Consider approval stream part** — AI SDK v3 has `tool-approval-request`; Codex has
   `item/commandExecution/requestApproval`. These could be wired for interactive use-cases.
