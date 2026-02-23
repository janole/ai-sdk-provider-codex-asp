# @janole/ai-sdk-provider-codex-asp

`@janole/ai-sdk-provider-codex-asp` is a Vercel AI SDK v6 custom provider for the Codex App Server Protocol.

Status: POC feature-complete for language model usage.

- `LanguageModelV3` provider implementation
- `doStream` via Codex app-server lifecycle
- `doGenerate` via stream aggregation
- `stdio` and `websocket` transports
- dynamicTools dispatcher (experimental)

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

## Transport Options

### Stdio (default)

Uses:

```bash
codex app-server --listen stdio://
```

Config:

```ts
const codex = createCodexAppServer({
  transport: {
    type: 'stdio',
    stdio: {
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      cwd: process.cwd(),
    },
  },
});
```

### WebSocket

Connects to a running app-server websocket endpoint.

```ts
const codex = createCodexAppServer({
  transport: {
    type: 'websocket',
    websocket: {
      url: 'ws://localhost:3000',
      headers: {
        Authorization: 'Bearer <token>',
      },
    },
  },
});
```

## dynamicTools (Experimental)

Codex can send inbound `item/tool/call` requests to the client. Register handlers with `toolHandlers`.

```ts
import { streamText } from 'ai';
import { createCodexAppServer } from '@janole/ai-sdk-provider-codex-asp';

const codex = createCodexAppServer({
  experimentalApi: true,
  toolTimeoutMs: 30_000,
  toolHandlers: {
    lookup_ticket: async (args) => {
      const id = (args as { id?: string }).id ?? 'unknown';
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: `Ticket ${id} is open.` }],
      };
    },
  },
});

const result = streamText({
  model: codex('gpt-5.3-codex'),
  prompt: 'Check ticket ABC-123 and summarize status.',
});
```

## API Reference

`createCodexAppServer(settings?)`

- `defaultModel?: string`
- `clientInfo?: { name: string; version: string; title?: string }`
- `experimentalApi?: boolean`
- `defaultThreadSettings?: {`
- `  cwd?: string`
- `  approvalMode?: 'never' | 'on-request' | 'on-failure' | 'untrusted'`
- `  sandboxMode?: 'read-only' | 'workspace-write' | 'full-access'`
- `}`
- `transport?: {`
- `  type?: 'stdio' | 'websocket'`
- `  stdio?: { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv }`
- `  websocket?: { url?: string; headers?: Record<string, string> }`
- `}`
- `persistent?: {`
- `  poolSize?: number`
- `  idleTimeoutMs?: number`
- `  scope?: 'provider' | 'global'` (default `'provider'`)
- `  key?: string` (global pool key, default `'default'`)
- `}`
- `toolHandlers?: Record<string, DynamicToolHandler>`
- `toolTimeoutMs?: number` (default `30000`)
- `transportFactory?: () => CodexTransport` (advanced testing/injection)

Provider methods:

- `provider(modelId)`
- `provider.languageModel(modelId)`
- `provider.chat(modelId)`

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
