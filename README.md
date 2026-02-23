# @janole/ai-sdk-provider-codex-asp

`@janole/ai-sdk-provider-codex-asp` is a Vercel AI SDK v6 custom provider for the Codex App Server Protocol.

Status: POC feature-complete for language model usage.

- `LanguageModelV3` provider implementation
- Streaming (`streamText`) and non-streaming (`generateText`)
- Standard AI SDK `tool()` support via Codex dynamic tools injection
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

### `createCodexAppServer(settings?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultModel` | `string` | — | Model ID used when none is passed to `codex()` |
| `clientInfo` | `{ name, version, title? }` | from `package.json` | Client identity sent to Codex during `initialize` |
| `experimentalApi` | `boolean` | `false` | Enable experimental Codex capabilities (auto-enabled when tools are registered) |
| `toolHandlers` | `Record<string, DynamicToolHandler>` | — | Handler-only tools (not advertised to Codex) |
| `toolTimeoutMs` | `number` | `30000` | Timeout per dynamic tool call |
| `transportFactory` | `() => CodexTransport` | — | Custom transport factory for testing/injection |

**`defaultThreadSettings`**

| Option | Type | Description |
|--------|------|-------------|
| `cwd` | `string` | Working directory for the Codex thread |
| `approvalMode` | `'never' \| 'on-request' \| 'on-failure' \| 'untrusted'` | When to request approval for commands |
| `sandboxMode` | `'read-only' \| 'workspace-write' \| 'full-access'` | File system access level |

**`transport`**

| Option | Type | Description |
|--------|------|-------------|
| `type` | `'stdio' \| 'websocket'` | Transport type (default: `'stdio'`) |
| `stdio` | `{ command?, args?, cwd?, env? }` | Stdio transport settings |
| `websocket` | `{ url?, headers? }` | WebSocket transport settings |

**`persistent`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolSize` | `number` | `1` | Number of persistent workers |
| `idleTimeoutMs` | `number` | `300000` | Idle timeout before worker shutdown |
| `scope` | `'provider' \| 'global'` | `'provider'` | Pool sharing scope |
| `key` | `string` | `'default'` | Global pool key (when scope is `'global'`) |

### Provider methods

- `provider(modelId)` — returns a language model instance
- `provider.languageModel(modelId)` — same as above (explicit)
- `provider.chat(modelId)` — alias for `languageModel`

## Examples

- Basic local stdio generation: see tests `tests/model.stream.test.ts`
- WebSocket transport exchange: see `tests/transport-websocket.test.ts`
- Dynamic tool dispatching: see `tests/dynamic-tools.test.ts`

## Troubleshooting

- `No such file or command: codex`:
  - Install Codex CLI and ensure `codex` is in `PATH`.
- `WebSocket is not available in this runtime`:
  - Use Node.js 18+ with global WebSocket support, or use `stdio` transport.
- Request timeouts:
  - Increase `toolTimeoutMs` for long-running dynamic tools.
- Empty generated text:
  - Verify Codex emits `item/agentMessage/delta` and `turn/completed` notifications.

## Development

```bash
npm install
npm run typecheck
npm run test
npm run build
```

## License

MIT
