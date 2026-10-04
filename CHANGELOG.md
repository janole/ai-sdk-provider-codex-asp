# Changelog

Entries from `0.5.0` onwards are per release. Earlier versions are grouped by minor series,
since most of their patch releases were protocol-type upgrades and dependency maintenance.
Full detail for any version is in the [releases](https://github.com/janole/ai-sdk-provider-codex-asp/releases)
and the git history.

## Unreleased

- The persistent worker pool now keeps every thread on the worker that loaded it. Codex 0.159
  added a per-thread writer lease: a thread loaded in one app-server process cannot be
  `thread/resume`d in another (`thread … already has an active writer`), and neither
  `thread/unsubscribe` nor idling releases it — only the process exiting does. The pool handed
  each turn to the first idle worker, so two concurrent sessions swapped workers as soon as their
  turns overlapped, and the second resume failed. Now a thread's turn goes to its owner, waiting
  while the owner is busy; a new thread goes to the worker holding the fewest threads, so
  concurrent sessions spread across processes; ownership ends when the process does.
- `scripts/writer-lease-probe.ts` checks the lease and the pool's routing against the real
  `codex` binary without a model call. Run it after a `codex` upgrade.

## 0.5.7

- A failed turn now reports **why** it failed (#85). `turn/completed` carries a `turn.error`
  block — message, `codexErrorInfo`, `additionalDetails` — whenever `turn.status` is `failed`, and
  the mapper read only the status, to pick a `finishReason`. Everything else was dropped, so a
  usage limit, an exhausted context window and an expired credential all reached the consumer as
  one indistinguishable turn with no content, and `finishReason: { unified: "error" }` was the only
  hint that anything had gone wrong. The failure is now emitted as an `error` stream part carrying
  a new `CodexTurnFailedError`, *before* the `finish` part, so the stream still terminates normally
  and whatever the turn did produce is still settled.
- New exported `CodexTurnFailedError` with `codexErrorInfo` (`"usageLimitExceeded"`,
  `"contextWindowExceeded"`, `"unauthorized"`, …) and `additionalDetails`. Branch on
  `codexErrorInfo`, not on the message — the prose is upstream's and may be reworded. Which classes
  are worth retrying is deliberately left to the consumer; this package reports what Codex said.
- A `failed` turn with no `error` block (unreachable per the protocol) is reported with a
  stand-in message rather than silently, since the silence is the bug being fixed.

## 0.5.6

- A transport that dies mid-turn now terminates the in-flight stream (#83). `AppServerClient`
  failed only `pendingRequests` on transport `error`, but a turn is a long-lived stream fed by
  notifications, not a pending request — so a killed or crashed app server left the consumer's
  `for await` parked forever, with no error and no finish. `close` is now handled alongside
  `error` and both surface through a new `AppServerClient.onTransportFailure()`, which
  `doStream()` uses to close the stream with an error part naming the exit code or signal.
  A peer killed by a signal emitted only `close`, never `error`, so the previous handler never
  ran at all.
- A pooled worker whose transport died mid-turn is returned to the pool (#83), since the stream
  now closes and disconnects instead of holding it forever. A worker parked on a *cross-call*
  tool call when its process died is still reserved for a thread that can never answer it —
  reclaiming that slot needs an abandonment record the next step can refuse on, and is left for
  a follow-up.
- A late `close` from a replaced transport no longer disconnects the worker's current one (#83).
- A request whose *send* fails no longer orphans its pending entry (#83). Nothing awaits the
  promise in that case — the caller got the send's throw instead — so the next `disconnect()`
  rejected it with no handler attached, which Node reports as an unhandled rejection. Reached
  whenever an abort raced the app server's death, and fatal in a host that exits the process on
  `unhandledRejection`.
- **Behaviour change:** a malformed line on the transport now fails the turn (#83). Both stdio
  and websocket transports emit `"error"` for a line that does not parse as JSON, and that now
  terminates the stream rather than only rejecting pending requests. A desynced protocol stream
  fails loudly instead of continuing with messages silently dropped.

## 0.5.5

Tracks the Codex app-server protocol up to codex-cli 0.154.0.

- Protocol types regenerated for Codex 0.154.0 (#80). Three new required fields —
  `RateLimitSnapshot.normalModelSlug`, `CommandExecutionRequestApprovalParams.kind`, and
  `ToolRequestUserInputParams.isBlocking` (deprecating `autoResolutionMs`) — plus new union
  variants (`ThreadItem.functionCallOutput`, `ResponseItem.configuration_update`,
  `CodexErrorInfo.rateLimitExceeded` and `.misalignmentPolicyViolation`) and additive fields
  across `Thread`, `TurnStartParams`, `TurnError`, `Model`, `GetAccountRateLimitsResponse` and
  `ImageGenerationItem`. Backward compatible for the provider.
- `normalModelSlug` survives rolling rate-limit updates (#80). The sparse merge rebuilds the
  snapshot field by field, so a field it does not name is dropped at the first
  `account/rateLimits/updated` — the slug would have appeared after the initial read and then
  silently vanished.
- Approval callers should branch on `CommandExecutionRequestApprovalParams.kind` (#80): stdin
  written to a running terminal now reaches `onCommandApproval` on the same request method as a
  command approval, with the stdin payload in `command`. An allowlist matched against `command`
  will otherwise treat stdin as a command.
- 13 newly referenced generated protocol files tracked, keeping the committed import closure
  complete (#80)
- README aligned with codex-cli 0.154.0; approval-callback notes cover `kind` (#80)
- `vitest` bumped to 4.1.11, clearing GHSA-82fw-gwwq-j7x9 (moderate, path traversal via the
  `@vitest/mocker` redirect mock) (#81). Test-runner only — `vitest` is a devDependency and is
  not part of the published package.
- Lockfile dependencies refreshed to newer patch versions

## 0.5.4

- Resumed threads no longer re-report the previous turn's token usage when the worker pool
  assigns a different worker (#79). Thread-cumulative usage baselines moved to worker-pool scope
  rather than living on an individual worker, so a repeated previous-turn notification can no
  longer make the next turn report the sum of both. Delta-based accounting for turns spanning
  multiple model requests is unchanged.

## 0.5.3

Surfaces Codex account rate limits through the provider's existing metadata channel.

- Rate-limit state attached to provider metadata as `rateLimits` + `rateLimitsRevision`,
  alongside `threadId` and `turnId` (#78). The provider reads `account/rateLimits/read` before
  each model call and selects the `codex` bucket.
- Sparse `account/rateLimits/updated` notifications merge without clearing fields the server
  reports as unavailable (#78)
- The rate-limit read is best-effort, so API-key authentication and older app servers continue
  without the metadata (#78)
- Generated Codex rate-limit types and snapshot helpers exported (#78)
- CHANGELOG backfilled and the release procedure recorded (#77)
- `brace-expansion` updated to 5.0.8 in the lockfile

## 0.5.2

Fixes token usage reporting, which covered only the final model request of a turn.

- Usage now covers the whole step rather than the last model request (#76). Codex reports
  `last` per *model request* and `total` cumulatively for the thread; the mapper assigned
  `last` and overwrote it on every notification, so a turn spanning dozens of model requests
  reported only the final one. Against a real 17-turn / 263-request session this
  under-reported input tokens by roughly 14x (7.1% of actual).
- Cross-call steps that close at a tool boundary report usage instead of zero (#76). The
  baseline is carried across steps, so a step opening with the notification that closed the
  previous one no longer counts that request twice.
- `inputTokens.noCache`, `inputTokens.cacheWrite` and `outputTokens.text` are populated,
  where they were previously always `undefined` (#76)
- `usage.raw` carries the Codex breakdown — `total`, `last` and `modelContextWindow` (#76)
- Protocol types regenerated for Codex 0.145.0 (#76). Additive throughout;
  `TokenUsageBreakdown` gained `cacheWriteInputTokens`, which is what made `cacheWrite`
  reportable.
- Added cross-call and inline repro examples for Codex abandoning a tool call during a slow
  approval

## 0.5.1

- Surface an interrupted tool-result when Codex abandons a parked cross-call tool (#75),
  instead of responding into a turn that no longer exists — this is what stops the stream
  hanging when a human approval never lands in time
- README and examples aligned with Codex 0.144.4 and `gpt-5.6-sol` (#74)
- Added an npm release-age safeguard to reduce supply-chain risk

## 0.5.0

Adds support for Vercel AI SDK v7 alongside v6, from a single package.

- `peerDependencies.ai` widened to `^6.0.0 || ^7.0.0`
- `@ai-sdk/provider` widened to `^3.0.0 || ^4.0.0` — both majors ship the `LanguageModelV3` types this provider implements
- Dropped the unused `@ai-sdk/provider-utils` dependency
- CI now runs the quality gate against both `ai@6` and `ai@7`

No source changes: `ai@7` accepts a `LanguageModelV3` model at runtime and proxies
it forward to `LanguageModelV4`, so the existing implementation works on both majors.
Note that `ai@7` itself requires Node.js 22+; this package still supports Node 20 on
the `ai@6` path.

## 0.4.x (0.4.0 – 0.4.16)

Protocol tracking and broader provider-executed tool coverage.

- Codex protocol types tracked from 0.116.0 through 0.144.4 (#52, #56, #57, #58, #60, #63, #71, #72)
- `CodexCallOptions` for per-call provider settings overrides (#51), with per-call approval
  callbacks (#54) and an `approvalsReviewer` option (#53)
- `imageGeneration` events surfaced as AI SDK file stream parts (#66)
- Tool user input and elicitation approval handlers (#65)
- `threadPath` added to provider metadata on stream-start (#64)
- `ephemeral` flag support in thread start parameters (#62)
- Cross-call fixes: provider-executed tool results preserved across step boundaries (#68),
  duplicate dynamic tool lifecycle parts removed on resume (#59, #69), dispatcher detached
  after use (#55)
- Placeholder `webSearch` items suppressed, with completed searches emitted with their
  results (#67)
- Abort closes the stream immediately rather than waiting for `turn/interrupt` to settle
- stderr buffered and reported on exit failure instead of erroring immediately (#61)
- Default model updated to `gpt-5.5`, and `modelId` now takes priority over `defaultModel`

## 0.3.x (0.3.0 – 0.3.6)

Provider-executed tool protocol coverage and internal restructuring.

- `fileChange` and `webSearch` mapped as provider-executed tool calls (#47); `mcpToolCall`
  mapped the same way with simplified output handling (#50)
- Tool results return the native `ThreadItem` (#49)
- Missing web search and tool mappings added (#44)
- Event-mapper switch replaced with a handler map (#39)
- Positional `transportFactory` arguments replaced with a `TransportContext` object (#38)
- Thread continuation fixed across provider restarts (#37)
- Session listener leaks and pool handle cleanup fixed in the worker pool (#35)
- Codex protocol types upgraded through 0.113.0 (#41, #42, #46)
- Added the `ok` script and the create-release skill

## 0.2.x (0.2.0 – 0.2.4)

Prompt, pool and discovery features.

- Image and file support in prompt resolution (#30)
- Structured output schema forwarding, with a validation example (#31)
- MCP server configuration via provider settings (#32)
- Model discovery via `listModels()` (#33)
- Mid-turn injection through an `onSessionCreated` session callback (#34)
- Worker pool queues saturated acquires with FIFO handoff (#29)
- `turn/plan/updated` mapped as tool-call/tool-result stream parts (#26), MCP tool call
  begin/end wrapper events mapped (#25), duplicate `agent_reasoning` wrappers ignored (#27)
- Event mapper crash fixes and deduplication (#24)
- Codex protocol types updated for 0.106.0 (#28)

## 0.1.x (0.1.1 – 0.1.8)

Hardening on top of the initial release.

- Command execution events mapped to the provider-executed tool protocol (#7)
- Official protocol types adopted, with provider-executed dynamic tool support (#9)
- Reasoning and progress event handling in the event mapper
- Optional thread compaction on resume (#14), plus a `shouldCompactOnResume` policy (#19)
- Default turn sandbox policy support (#18)
- Packet-level JSON-RPC debug logging via an `onPacket` callback, and dynamic tool debug
  logging hooks (#16)
- Cross-call tool-result matching fixed, failing on a missing pending result (#15)
- `turn/interrupt` sent before disconnect on abort (#12)
- Thread resumed when `threadId` arrives on content-part `providerOptions` (#8)
- Default approval fallback changed to decline (#22)

## 0.1.0

Initial release of `@janole/ai-sdk-provider-codex-asp`.

- Vercel AI SDK v6 custom provider for the Codex App Server Protocol
- Support for streaming text generation and tool calls
- Thread management with persistent and transient modes
- Cross-call tool support
- ESM and CJS builds with full TypeScript type definitions
