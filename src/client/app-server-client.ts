import { CodexProviderError } from '../errors';
import type {
  CodexToolCallRequestParams,
  CodexToolCallResult,
} from '../protocol/types';
import type {
  CodexTransport,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from './transport';

export class JsonRpcError extends CodexProviderError {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = 'JsonRpcError';
    this.code = error.code;
    this.data = error.data;
  }
}

export interface AppServerClientSettings {
  requestTimeoutMs?: number;
}

type NotificationHandler = (params: unknown) => void | Promise<void>;
type AnyNotificationHandler = (
  method: string,
  params: unknown,
) => void | Promise<void>;
type RequestHandler = (
  params: unknown,
  request: JsonRpcRequest,
) => unknown | Promise<unknown>;
type ToolCallRequestHandler = (
  params: CodexToolCallRequestParams,
  request: JsonRpcRequest,
) => CodexToolCallResult | Promise<CodexToolCallResult>;

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return (
    'id' in message &&
    message.id !== undefined &&
    ('result' in message || 'error' in message) &&
    !('method' in message)
  );
}

function isRequestOrNotification(
  message: JsonRpcMessage,
): message is JsonRpcRequest | { method: string; params?: unknown } {
  return 'method' in message && typeof message.method === 'string';
}

export class AppServerClient {
  private readonly transport: CodexTransport;
  private readonly requestTimeoutMs: number;
  private nextId = 1;

  private readonly pendingRequests = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly anyNotificationHandlers = new Set<AnyNotificationHandler>();
  private readonly requestHandlers = new Map<string, RequestHandler>();

  private removeMessageListener: (() => void) | null = null;
  private removeErrorListener: (() => void) | null = null;

  constructor(transport: CodexTransport, settings: AppServerClientSettings = {}) {
    this.transport = transport;
    this.requestTimeoutMs = settings.requestTimeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    await this.transport.connect();

    this.removeMessageListener = this.transport.on('message', (message) => {
      void this.handleMessage(message).catch(() => {
        // Inbound requests can race with disconnect; ignore transport write failures.
      });
    });

    this.removeErrorListener = this.transport.on('error', (error) => {
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pendingRequests.clear();
    });
  }

  async disconnect(): Promise<void> {
    if (this.removeMessageListener) {
      this.removeMessageListener();
      this.removeMessageListener = null;
    }

    if (this.removeErrorListener) {
      this.removeErrorListener();
      this.removeErrorListener = null;
    }

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexProviderError('Client disconnected.'));
    }
    this.pendingRequests.clear();

    await this.transport.disconnect();
  }

  async request<TResult>(
    method: string,
    params?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<TResult> {
    const id = this.nextId++;

    const message: JsonRpcRequest =
      params === undefined ? { id, method } : { id, method, params };

    const promise = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new CodexProviderError(`Request timed out: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });
    });

    await this.transport.sendMessage(message);
    return promise;
  }

  async notification(method: string, params?: unknown): Promise<void> {
    await this.transport.sendNotification(method, params);
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  onAnyNotification(handler: AnyNotificationHandler): () => void {
    this.anyNotificationHandlers.add(handler);
    return () => {
      this.anyNotificationHandlers.delete(handler);
    };
  }

  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);

    return () => {
      this.requestHandlers.delete(method);
    };
  }

  onToolCallRequest(handler: ToolCallRequestHandler): () => void {
    return this.onRequest('item/tool/call', async (params, request) =>
      handler((params ?? {}) as CodexToolCallRequestParams, request),
    );
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (isResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (!isRequestOrNotification(message)) {
      return;
    }

    const hasRequestId = 'id' in message && message.id !== undefined;

    if (hasRequestId) {
      await this.handleInboundRequest(message as JsonRpcRequest);
      return;
    }

    await this.handleNotification(message.method, message.params);
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.id);

    if ('error' in message) {
      pending.reject(new JsonRpcError(message.error));
      return;
    }

    pending.resolve((message as JsonRpcSuccessResponse).result);
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      for (const handler of handlers) {
        await handler(params);
      }
    }

    for (const handler of this.anyNotificationHandlers) {
      await handler(method, params);
    }
  }

  private async handleInboundRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(request.method);

    if (!handler) {
      await this.transport.sendMessage({
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      } as JsonRpcErrorResponse);
      return;
    }

    try {
      const result = await handler(request.params, request);
      await this.transport.sendMessage({
        id: request.id,
        result,
      } as JsonRpcSuccessResponse);
    } catch (error) {
      try {
        await this.transport.sendMessage({
          id: request.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : 'Request handler failed',
          },
        } as JsonRpcErrorResponse);
      } catch {
        // Ignore transport errors while replying to inbound requests during shutdown.
      }
    }
  }
}
