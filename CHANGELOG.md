# Changelog

Entries from `0.5.0` onwards are per release. Earlier versions are grouped by minor series,
since most of their patch releases were protocol-type upgrades and dependency maintenance.
Full detail for any version is in the [releases](https://github.com/janole/ai-sdk-provider-codex-asp/releases)
and the git history.

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
