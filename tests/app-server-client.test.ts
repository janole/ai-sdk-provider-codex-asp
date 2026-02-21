import { describe, expect, it } from 'vitest';

import { AppServerClient, JsonRpcError } from '../src/client/app-server-client';
import { MockTransport } from './helpers/mock-transport';

describe('AppServerClient', () => {
  it('sends request and resolves response', async () => {
    const transport = new MockTransport();
    const client = new AppServerClient(transport, { requestTimeoutMs: 1000 });

    await client.connect();

    const promise = client.request<{ ok: boolean }>('initialize', { a: 1 });

    const request = transport.sentMessages[0];
    if (!request || !('id' in request)) {
      throw new Error('Expected request message with id');
    }

    transport.emitMessage({ id: request.id, result: { ok: true } });

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('rejects request on JSON-RPC error', async () => {
    const transport = new MockTransport();
    const client = new AppServerClient(transport, { requestTimeoutMs: 1000 });

    await client.connect();

    const promise = client.request('initialize', {});

    const request = transport.sentMessages[0];
    if (!request || !('id' in request)) {
      throw new Error('Expected request message with id');
    }

    transport.emitMessage({
      id: request.id,
      error: {
        code: -32000,
        message: 'boom',
      },
    });

    await expect(promise).rejects.toBeInstanceOf(JsonRpcError);
  });

  it('handles inbound JSON-RPC requests and responds', async () => {
    const transport = new MockTransport();
    const client = new AppServerClient(transport, { requestTimeoutMs: 1000 });

    await client.connect();

    client.onRequest('item/tool/call', async (params) => {
      return { ok: true, params };
    });

    transport.emitMessage({
      id: 99,
      method: 'item/tool/call',
      params: { tool: 'x' },
    });
    await Promise.resolve();

    const response = transport.sentMessages.at(-1);
    expect(response).toEqual({
      id: 99,
      result: { ok: true, params: { tool: 'x' } },
    });
  });
});
