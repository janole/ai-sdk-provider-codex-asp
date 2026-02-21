import type {
  CodexTransport,
  CodexTransportEventMap,
  JsonRpcMessage,
} from './transport';

export interface WebSocketTransportSettings {
  url?: string;
  headers?: Record<string, string>;
}

type ListenerStore = {
  [K in keyof CodexTransportEventMap]: Set<CodexTransportEventMap[K]>;
};

const DEFAULT_WS_URL = 'ws://localhost:3000';

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  init?: { headers?: Record<string, string> },
) => WebSocket;

export class WebSocketTransport implements CodexTransport {
  private readonly settings: WebSocketTransportSettings;
  private socket: WebSocket | null = null;
  private readonly listeners: ListenerStore = {
    message: new Set(),
    error: new Set(),
    close: new Set(),
  };

  constructor(settings: WebSocketTransportSettings = {}) {
    this.settings = settings;
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      return;
    }

    const WebSocketCtor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error('WebSocket is not available in this runtime.');
    }

    const socket = new WebSocketCtor(
      this.settings.url ?? DEFAULT_WS_URL,
      undefined,
      this.settings.headers ? { headers: this.settings.headers } : undefined,
    );

    this.socket = socket;

    socket.addEventListener('message', (event) => {
      this.handleIncomingMessage(event.data);
    });

    socket.addEventListener('error', (event) => {
      this.emit('error', event);
    });

    socket.addEventListener('close', (event) => {
      this.socket = null;
      this.emit('close', event.code, null);
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        resolve();
      };

      const onError = (event: Event) => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        reject(new Error(`WebSocket connection failed: ${String(event.type)}`));
      };

      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      return;
    }

    const socket = this.socket;

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      };

      socket.addEventListener('close', () => finish(), { once: true });
      socket.close();
      setTimeout(finish, 250);
    });

    this.socket = null;
  }

  async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('WebSocketTransport is not connected.');
    }

    this.socket.send(JSON.stringify(message));
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    await this.sendMessage(
      params === undefined ? { method } : { method, params },
    );
  }

  on<K extends keyof CodexTransportEventMap>(
    event: K,
    listener: CodexTransportEventMap[K],
  ): () => void {
    const listeners = this.listeners[event] as Set<CodexTransportEventMap[K]>;
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }

  private handleIncomingMessage(raw: unknown): void {
    try {
      if (typeof raw !== 'string') {
        return;
      }

      const message = JSON.parse(raw) as JsonRpcMessage;
      this.emit('message', message);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private emit<K extends keyof CodexTransportEventMap>(
    event: K,
    ...args: Parameters<CodexTransportEventMap[K]>
  ): void {
    const listeners = this.listeners[event] as Set<(...handlerArgs: Parameters<CodexTransportEventMap[K]>) => void>;

    for (const listener of listeners) {
      listener(...args);
    }
  }
}
