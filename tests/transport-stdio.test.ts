import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { StdioTransport } from '../src/client/transport-stdio';

describe('StdioTransport', () => {
  it('spawns a process and exchanges JSONL messages', async () => {
    const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/rpc-echo.mjs');

    const transport = new StdioTransport({
      command: process.execPath,
      args: [fixturePath],
    });

    const messagePromise = new Promise<unknown>((resolve) => {
      const off = transport.on('message', (message) => {
        off();
        resolve(message);
      });
    });

    await transport.connect();
    await transport.sendMessage({ id: 1, method: 'initialize', params: {} });

    const response = await messagePromise;
    expect(response).toEqual({
      id: 1,
      result: {
        ok: true,
        method: 'initialize',
      },
    });

    await transport.disconnect();
  });
});
