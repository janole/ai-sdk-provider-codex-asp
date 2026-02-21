# Persistent Transport / Codex Daemon

## Background

Currently each `doStream()` call creates a fresh connection to Codex:

```
doStream() → spawn codex process → initialize → thread/start → turn/start → ... → disconnect
```

This means every request pays the full process startup + handshake cost (~3 sequential round-trips
before the first token). For interactive use-cases this is noticeable latency.

**Thread continuity is already solved** (2026-02-22): the `threadId` is stored in the `finish`
stream part's `providerMetadata` under `"codex-app-server"`. On the next call `doStream()` finds
it in the last assistant message's `providerOptions` and calls `thread/resume` instead of
`thread/start`. Codex reloads the conversation context from disk automatically.

What's still missing is **process continuity** — keeping the Codex process alive between calls.

## Reference Implementation

`@janole/chat-server` → `packages/ai-tools/codex/`

- `daemon.ts` — singleton `CodexDaemon`, fixed-size worker pool (`CODEX_POOL_SIZE`, default 2)
- `worker.ts` — `CodexWorker`, one long-lived Codex process per worker, serialised request queue
- `runtime/process-codex-runtime-adapter.ts` — process lifecycle, workspace tracking, git state

Key patterns to borrow:
- Worker pool with least-loaded routing
- Serial queue per worker (promise chain, avoids interleaved stdin writes)
- `ensureRuntimeReady()` — initialises the process once, reuses across turns
- `bumpTimeout()` — resets inactivity timer on each incoming message (default 120 s)
- `markIdle()` / workspace state machine — tracks git state between turns

## Proposed Design

Add a `PersistentTransport` (or `CodexDaemonTransport`) that implements `CodexTransport` but
wraps a shared, long-lived connection instead of spawning a new process per call.

```ts
// New transport option
createCodexAppServer({
    transport: { type: "persistent", poolSize: 2 },
    // or:
    transportFactory: PersistentCodexTransport.factory({ poolSize: 2 }),
})
```

Internally:

```
PersistentCodexTransport
  └─ CodexWorkerPool  (singleton or scoped to provider instance)
       ├─ Worker 0   [codex process, initialized, idle/busy]
       └─ Worker 1   [codex process, initialized, idle/busy]
```

Each worker holds an already-initialized Codex process. When `doStream()` acquires a worker:
1. Skip `initialize` + `initialized` (already done at startup)
2. If `resumeThreadId` in prompt → `thread/resume`; else → `thread/start`
3. `turn/start` → stream events → done
4. Release worker back to pool

## What Doesn't Need to Change

- `CodexLanguageModel` (`model.ts`) — no changes needed
- `CodexEventMapper` — no changes needed
- `DynamicToolsDispatcher` — no changes needed
- Thread resumption via `providerMetadata` — works as-is, still valuable even with persistent process

## What Needs to Be Built

- [ ] `CodexWorkerPool` — manages N persistent `AppServerClient` instances
- [ ] Startup initialisation — `initialize` + `initialized` once per worker at pool creation
- [ ] Idle timeout / health check — restart a worker if the process dies
- [ ] `PersistentCodexTransport` implementing `CodexTransport`, delegates to pool
- [ ] Graceful shutdown — `disconnect()` on all workers (e.g. on process exit)
- [ ] Optional: workspace tracking (cwd per thread, like chat-server's `WorkspaceManager`)

## Open Questions

- Should the pool be scoped to the provider instance or be a true singleton?
  (Singleton risks port/process conflicts if multiple providers are created.)
- How to handle a worker that crashes mid-turn? Re-queue on another worker or surface as error?
- For the stdio transport, should we reuse the existing `StdioTransport` or write a dedicated
  persistent variant?
- Approval interrupt/resume (command approval, file change approval) — out of scope for now
  but the worker pool is a prerequisite for it.

## Related

- `docs/poc-analysis.md` §5 "Per-call vs Persistent Connection"
- `docs/poc-analysis.md` §8 "Suggested Next Steps" (item 1)
- Reference: `@janole/chat-server/packages/ai-tools/codex/worker.ts` (~940 LOC)
