# Prompt Mapper Improvement

## Current State

`src/protocol/prompt-mapper.ts` is a POC that flattens the entire prompt into a
single text blob:

```ts
// All system + user text → one CodexTurnInputItem
return [{ type: "text", text: chunks.join("\n\n"), text_elements: [] }];
```

Problems:
- **Roles are erased** — system prompt, prior user turns, and the current user
  turn all merge into one string; Codex sees no structural distinction.
- **Images are dropped** — `user` content parts with `type: "image"` are silently
  ignored.
- **Tool results are dropped** — `tool` role messages are ignored.
- **History is re-sent** — when thread resumption is used (threadId in
  providerMetadata), the full prompt history is still mapped and sent in the
  `turn/start` input even though Codex already has the context loaded from disk.
  Only the **new** user turn should be sent.
- **text_elements are always empty** — mentions and skills can be represented
  structurally but currently aren't.

## What the Protocol Supports

### `turn/start` `input: Array<UserInput>`

```ts
// v2/UserInput.ts (generated)
type UserInput =
  | { type: "text"; text: string; text_elements: Array<TextElement> }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

// v2/TextElement.ts
type TextElement = {
  byteRange: ByteRange;          // byte offsets into `text`
  placeholder: string | null;    // human-readable label for the element
};

// v2/ByteRange.ts
type ByteRange = { start: number; end: number };
```

`TextElement` records are used by the Codex UI to render mentions/skills inline
within a `text` item — they aren't strictly required for function, but including
them enables richer behaviour server-side.

### `thread/start` (and `thread/resume`) system-prompt fields

```ts
// v2/ThreadStartParams.ts (generated)
{
  baseInstructions?: string | null;        // replaces Codex default system prompt
  developerInstructions?: string | null;   // appended after base instructions
  // ...
}
```

The AI SDK `"system"` role maps naturally to `developerInstructions` (appended,
not replacing Codex defaults) or `baseInstructions` (full replacement).

## Improvement Roadmap

### Phase 1 — Keep roles separate (minimal viable fix)

Extract only the **last user turn** as `turn/start` input when a `resumeThreadId`
is present (thread resumed from disk). When starting a fresh thread, still send
all user content but do **not** merge it into one blob:

```ts
// Fresh thread: multiple text items, one per user turn
[
  { type: "text", text: "first message", text_elements: [] },
  { type: "text", text: "second message", text_elements: [] },
]

// Resumed thread: only the latest user turn
[{ type: "text", text: "continue...", text_elements: [] }]
```

System prompt → pass to `thread/start` as `developerInstructions` (or
`baseInstructions` if a provider option opts in to replacement semantics).

### Phase 2 — Image support

Map AI SDK image parts to `UserInput`:

| AI SDK content part | `UserInput` variant |
|---------------------|---------------------|
| `{ type: "image", image: URL }` | `{ type: "image", url: string }` |
| `{ type: "image", image: Uint8Array/base64 }` | Not directly supported — could write temp file → `localImage`, or skip with warning |
| `{ type: "file", mimeType: "image/*" }` | Same as above |

### Phase 3 — Mentions and skills (text_elements)

The AI SDK has no native concept of mentions/skills, but they could be introduced
via a custom syntax in the text (e.g. `@filename` or `#skill-name`) that the
mapper parses and converts into:

```ts
{
  type: "text",
  text: "Fix the bug in @src/foo.ts",
  text_elements: [
    { byteRange: { start: 15, end: 28 }, placeholder: "src/foo.ts" }
  ]
}
```

Or via a structured `providerOptions` field on the user message that carries
pre-built `text_elements` (opt-in, no magic parsing needed).

### Phase 4 — Tool results

When `thread/resume` is used, tool calls and their results are already in
Codex's stored history. For a **fresh thread** with prior tool-call messages in
the prompt, there is currently no clean mapping — Codex doesn't accept raw tool
result history via `turn/start`. Options:

- Ignore tool results in the prompt (current behaviour, silent drop).
- Surface a warning stream part when tool results are detected and ignored.
- Future: use `thread/resume` with `history` override (Codex Cloud path,
  marked `[UNSTABLE]` in generated types).

## What Doesn't Need to Change

- `CodexEventMapper` — stream part mapping is independent of prompt mapping.
- `CodexLanguageModel.doStream()` — calls `mapPromptToTurnInput(options.prompt)`
  and passes the result to `turn/start`; no structural change needed there
  (though passing `resumeThreadId` into the mapper is required for Phase 1).
- Thread resumption via `providerMetadata` — already works, just needs the
  mapper to stop re-sending history.

## What Needs to Be Built

- [ ] Accept `resumeThreadId?: string` parameter in `mapPromptToTurnInput`
- [ ] When `resumeThreadId` is set: extract only the last user turn's content
- [ ] When `resumeThreadId` is unset: emit one `text` item per user turn
  (preserving turn boundaries) rather than one merged blob
- [ ] Route `system` message to `developerInstructions` on `thread/start` /
  `thread/resume` instead of folding into user text
  - Requires `mapPromptToTurnInput` to return a richer object (or split into two
    functions: `mapSystemPrompt` and `mapUserInput`)
- [ ] Phase 2: map `image` content parts to `{ type: "image", url }` or
  `{ type: "localImage", path }` with a warning for unsupported encodings
- [ ] Phase 3: optional `text_elements` support (providerOptions or parsing)

## Open Questions

- Should the mapper emit a `stream-start` warning when it silently drops content
  (images, tool results) — or fail loudly?
- For `baseInstructions` vs `developerInstructions`: should the provider default
  to `developerInstructions` (append) and let callers opt into `baseInstructions`
  (replace) via `defaultThreadSettings`?
- When multiple system messages appear in the prompt (AI SDK allows it), should
  they be concatenated or only the last one used?

## Escape Hatch — Synthetic Session Files

If the stateless-history approach hits a dead end (e.g. Codex fundamentally
can't reconstruct context from `turn/start` input alone), there is an
alternative: **write a synthetic rollout file and resume from it**.

Codex stores sessions as JSONL under `~/.codex/sessions/YYYY/MM/DD/`:

```
rollout-{YYYY-MM-DDThh-mm-ss}-{uuid}.jsonl
```

Each line is `{ timestamp, type, payload }`. A minimal synthetic session needs:

```jsonl
{"timestamp":"...","type":"session_meta","payload":{"id":"<uuid>","cwd":"...","originator":"...","cli_version":"0.1.0","source":"cli","model_provider":"openai","timestamp":"..."}}
{"timestamp":"...","type":"event_msg","payload":{"type":"user_message","message":"Hello","images":null,"local_images":[],"text_elements":[]}}
{"timestamp":"...","type":"event_msg","payload":{"type":"agent_message","message":"Hi!","phase":null}}
```

Then `thread/resume` with that UUID finds the file automatically.
`ThreadResumeParams` also has an (unstable) `path` field to pass the file path
directly, bypassing the directory scan.

**Caveat:** it's unclear whether `event_msg`-only files give Codex enough to
reconstruct the model's context window, or whether `response_item` entries
(actual OpenAI API objects) are also required. Needs an empirical test.

**Source:** `codex-rs/core/src/rollout/recorder.rs` — `RolloutItem`,
`EventMsg::UserMessage`, `EventMsg::AgentMessage` (2026-02-22).

## Related

- `src/protocol/prompt-mapper.ts` — current implementation
- `src/model.ts` — calls `mapPromptToTurnInput`, passes `resumeThreadId`
- `docs/poc-analysis.md` §3 "Prompt → Turn Input Mapping" and §7 "Gaps / TODOs"
- Generated reference: `v2/UserInput.ts`, `v2/TextElement.ts`, `v2/ByteRange.ts`,
  `v2/ThreadStartParams.ts`, `v2/TurnStartParams.ts`
