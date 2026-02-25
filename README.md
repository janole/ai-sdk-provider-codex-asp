# @janole/ai-sdk-provider-codex-asp

`@janole/ai-sdk-provider-codex-asp` is a [Vercel AI SDK](https://ai-sdk.dev/) v6 custom provider for the Codex App Server Protocol.

Status: POC feature-complete for language model usage. Currently tested with [codex-cli](https://github.com/openai/codex/releases/tag/rust-v0.104.0) 0.104.0.

- `LanguageModelV3` provider implementation
- Streaming (`streamText`) and non-streaming (`generateText`)
- Standard AI SDK `tool()` support via Codex dynamic tools injection
- Provider-executed tool protocol for Codex command executions
- `stdio` and `websocket` transports
- Persistent worker pool with thread management

## Installation

```bash
npm install @janole/ai-sdk-provider-codex-asp ai
```

## Quick Start

### 1. Non-streaming (`generateText`)

```ts
import { generateText } from 'ai';
import { createCodexAppServer } from '@janole/ai-sdk-provider-codex-asp';

const codex = createCodexAppServer({
  defaultModel: 'gpt-5.3-codex',
  clientInfo: { name: 'my-app', version: '0.1.0' },
});

const result = await generateText({
  model: codex.languageModel('gpt-5.3-codex'),
  prompt: 'Write a short release note title for websocket support.',
});

console.log(result.text);
```

### 2. Streaming (`streamText`)

```ts
import { streamText } from 'ai';
import { createCodexAppServer } from '@janole/ai-sdk-provider-codex-asp';

const codex = createCodexAppServer({
  defaultModel: 'gpt-5.3-codex',
  clientInfo: { name: 'my-app', version: '0.1.0' },
});

const result = streamText({
  model: codex('gpt-5.3-codex'),
  prompt: 'Explain JSON-RPC in one paragraph.',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

## Tools

Use standard AI SDK `tool()` definitions — the provider automatically injects them into Codex as dynamic tools and routes results back. No Codex-specific API needed.

Requires a persistent transport so tool results can be fed back within the same session:

```ts
import { stepCountIs, streamText, tool } from 'ai';
import { z } from 'zod';
import { createCodexAppServer } from '@janole/ai-sdk-provider-codex-asp';

const codex = createCodexAppServer({
  persistent: { scope: 'global', poolSize: 1, idleTimeoutMs: 60_000 },
});

const result = streamText({
  model: codex('gpt-5.3-codex'),
  prompt: 'Can you check ticket 15 and also the weather in Berlin?',
  tools: {
    lookup_ticket: tool({
      description: 'Look up the current status of a support ticket by its ID.',
      inputSchema: z.object({
        id: z.string().describe('The ticket ID, e.g. "TICK-42".'),
      }),
      execute: async ({ id }) => `Ticket ${id} is open and assigned to team Alpha.`,
    }),
    check_weather: tool({
      description: 'Get the current weather for a given location.',
      inputSchema: z.object({
        location: z.string().describe('City name or coordinates.'),
      }),
      execute: async ({ location }) => `Weather in ${location}: 22°C, sunny`,
    }),
  },
  stopWhen: stepCountIs(5),
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

await codex.shutdown();
```

## API Reference

```ts
const codex = createCodexAppServer({
  defaultModel?: string,
  clientInfo?: { name, version, title? },  // defaults to package.json
  transport?: { type: 'stdio' | 'websocket', stdio?, websocket? },
  persistent?: { poolSize?, idleTimeoutMs?, scope?, key? },
  compaction?: { onResume?, strict? },     // optional thread/compact/start before resumed turns
  debug?: { logPackets?, logger? },         // packet-level JSON-RPC debug logging
  defaultThreadSettings?: { cwd?, approvalPolicy?, sandbox? },
  defaultTurnSettings?: { cwd?, approvalPolicy?, sandboxPolicy?, model?, effort?, summary? },
  approvals?: { onCommandApproval?, onFileChangeApproval? },
  toolTimeoutMs?: number,                  // default: 30000
  interruptTimeoutMs?: number,             // default: 10000
});

codex(modelId)                // returns a language model instance
codex.languageModel(modelId)  // explicit alias
codex.chat(modelId)           // explicit alias
codex.shutdown()              // clean up persistent workers
```

Rich sandbox policy example (turn-level):

```ts
const codex = createCodexAppServer({
  defaultTurnSettings: {
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "externalSandbox",
      networkAccess: "enabled",
    },
  },
});
```

See [`src/provider.ts`](src/provider.ts) for full type definitions.

## Examples

See the [`examples/`](examples/) directory:

- [`generate-text.ts`](examples/generate-text.ts) — Non-streaming text generation
- [`stream-text.ts`](examples/stream-text.ts) — Streaming text generation
- [`cross-call-tools.ts`](examples/cross-call-tools.ts) — Standard AI SDK tools via Codex
- [`dynamic-tools.ts`](examples/dynamic-tools.ts) — Provider-level dynamic tools
- [`thread-continuation.ts`](examples/thread-continuation.ts) — Multi-turn thread resumption
- [`approvals.ts`](examples/approvals.ts) — Command and file-change approval handling

Run any example with:

```bash
npx tsx examples/stream-text.ts
```

## Troubleshooting

- `No such file or command: codex`:
  - Install Codex CLI and ensure `codex` is in `PATH`.
- `WebSocket is not available in this runtime`:
  - Use Node.js 18+ with global WebSocket support, or use `stdio` transport.
- Request timeouts:
  - Increase `toolTimeoutMs` for long-running dynamic tools.
  - Increase `interruptTimeoutMs` if `turn/interrupt` acks are slow under heavy load.
- Empty generated text:
  - Verify Codex emits `item/agentMessage/delta` and `turn/completed` notifications.
- Compaction fails on resumed threads:
  - Leave `compaction.strict` unset/false to continue the turn when `thread/compact/start` fails.
  - Set `compaction.strict: true` if you want compaction failures to fail fast.

## Development

```bash
npm install
npm run build        # ESM + CJS + .d.ts via tsup
npm run qa           # lint + typecheck + test (all-in-one)
```

### Generated Protocol Types

`src/protocol/app-server-protocol/` is gitignored, but selected generated files are intentionally tracked via `git add -f`.
This keeps protocol diffs visible in PRs and local `git status` after regeneration.

When protocol shapes change, clean and regenerate:

```bash
rm -rf src/protocol/app-server-protocol
npm run codex:generate-types
```

## License

MIT
