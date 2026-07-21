# Changelog

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

## 0.1.0

Initial release of `@janole/ai-sdk-provider-codex-asp`.

- Vercel AI SDK v6 custom provider for the Codex App Server Protocol
- Support for streaming text generation and tool calls
- Thread management with persistent and transient modes
- Cross-call tool support
- ESM and CJS builds with full TypeScript type definitions
