# PRD: Queue-Based Worker Acquisition for Codex Provider

## Problem

When `@janole/ai-sdk-provider-codex-asp` runs with persistent transport and all workers are busy, new requests fail immediately with:

`CodexProviderError: All workers are busy. Try again later or increase poolSize.`

This causes user-visible failures during normal concurrent usage (for example, two active threads with `poolSize: 1`).

## Goal

Make provider behavior match the old `codexTools` daemon behavior:

- Per worker remains single-flight.
- Pool still provides parallelism (`poolSize`).
- Requests beyond capacity wait in a FIFO queue instead of failing fast.

## Project Locations

- Provider repo: `./janole/ai-sdk-provider-codex-asp`
- Consumer repo: `./janole/chat-server`

## Execution Trigger

If the user says "go for it" on this PRD, implementation should start in `./janole/ai-sdk-provider-codex-asp` first, then update `./janole/chat-server` only for dependency/version bump after release.

## Non-Goals

- No change to model output semantics.
- No change to approval policy defaults.
- No redesign of persistent pool scoping (`provider` vs `global`).

## Requirements

1. Saturated pool must queue acquisition requests instead of throwing.
2. Queue order must be FIFO.
3. Releasing a worker must hand it directly to the next queued request.
4. Waiting requests must support cancellation via abort signal.
5. Shutdown must reject all queued waiters with a clear error.
6. Existing idle-timeout worker lifecycle remains intact when no queue is pending.

## Proposed Design

- Extend `CodexWorkerPool` with an internal waiter queue.
- Change acquisition path to:
  - immediate return if idle/disconnected worker exists,
  - otherwise enqueue waiter and resolve on future release.
- On `release(worker)`, prefer serving queued waiters before marking idle.
- Add cancellation hooks so aborted requests are removed from queue.
- Optionally support `acquireTimeoutMs` for bounded waiting.

## API / Behavior Impact

- Current fail-fast saturation errors become queued waiting behavior.
- New error surfaces (if timeout enabled): acquisition timeout / aborted while waiting.
- Backward compatible expected default: queue enabled.

## Acceptance Criteria

- With `poolSize: 1`, two concurrent `doStream` calls no longer fail due to busy pool.
- Second request starts after first worker release and completes successfully.
- FIFO queue order is deterministic under test.
- Abort before acquire prevents orphaned queued waiter.
- `shutdown()` rejects pending queued requests.

## Risks

- Potential longer perceived latency under saturation (queueing instead of immediate failure).
- If cancellation cleanup is incorrect, queue leaks are possible.

## Mitigations

- Add queue-length and wait-duration debug logging.
- Add targeted tests for cancellation and shutdown behavior.

## Rollout

1. Implement with queue enabled by default.
2. Validate in provider unit/integration tests.
3. Update README troubleshooting/behavior notes for concurrency.
4. Release new provider version and bump dependency in `chat-server`.

## Related Tasks

1. `b720356f-7aa3-43a1-9e44-a66149a845c4`
   - Title: Implement queued worker acquisition in CodexWorkerPool
   - Status: `todo`
   - Priority: `high`
   - Tags: `provider`, `concurrency`, `implementation`

2. `f0f1657e-97bd-47c0-a6ff-df7fa92bedfa`
   - Title: Wire cancellation for queued acquire waiters
   - Status: `todo`
   - Priority: `high`
   - Tags: `provider`, `concurrency`, `abort`

3. `1116ee53-0b89-45cd-b858-8329bd03359d`
   - Title: Add tests for queueing, FIFO, abort, and shutdown
   - Status: `todo`
   - Priority: `high`
   - Tags: `tests`, `provider`, `concurrency`

4. `d22d05fb-90da-49c5-8eae-8715d3967ad5`
   - Title: Release and consume updated provider in chat-server
   - Status: `todo`
   - Priority: `medium`
   - Tags: `release`, `dependency`, `chat-server`
