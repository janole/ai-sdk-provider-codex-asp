import { afterEach, describe, expect, it } from 'vitest';

import { WebSocketTransport } from '../src/client/transport-websocket';

class FakeWebSocket extends EventTarget {
  static readonly instances: FakeWebSocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);

    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event('close') as Event & { code: number };
    event.code = 1000;
    this.dispatchEvent(event);
  }

  receiveText(text: string): void {
    const event = new Event('message') as Event & { data: string };
    event.data = text;
    this.dispatchEvent(event);
  }
}

afterEach(() => {
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
  FakeWebSocket.instances.length = 0;
});

describe('WebSocketTransport', () => {
  it('connects, sends JSON-RPC message, and receives message frames', async () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket as unknown;

    const transport = new WebSocketTransport({ url: 'ws://localhost:1234' });

    const messagePromise = new Promise<unknown>((resolve) => {
      const off = transport.on('message', (message) => {
        off();
        resolve(message);
      });
    });

    await transport.connect();

    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toBe('ws://localhost:1234');

    await transport.sendMessage({ id: 1, method: 'initialize', params: {} });
    expect(socket?.sent[0]).toBe('{"id":1,"method":"initialize","params":{}}');

    socket?.receiveText('{"id":1,"result":{"ok":true}}');

    await expect(messagePromise).resolves.toEqual({ id: 1, result: { ok: true } });

    await transport.disconnect();
  });
});
