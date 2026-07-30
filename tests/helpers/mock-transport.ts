import type {
    CodexTransport,
    CodexTransportEventMap,
    JsonRpcMessage,
} from "../../src/client/transport";

export class MockTransport implements CodexTransport 
{
    readonly sentMessages: JsonRpcMessage[] = [];

    private readonly accountRateLimitsResult: unknown;
    private connected = false;
    private readonly listeners: {
        [K in keyof CodexTransportEventMap]: Set<CodexTransportEventMap[K]>;
    } = {
        message: new Set(),
        error: new Set(),
        close: new Set(),
    };

    constructor(accountRateLimitsResult?: unknown)
    {
        this.accountRateLimitsResult = accountRateLimitsResult;
    }

    connect(): Promise<void>
    {
        this.connected = true;

        return Promise.resolve();
    }

    disconnect(): Promise<void>
    {
        this.connected = false;
        this.emit("close", null, null);

        return Promise.resolve();
    }

    sendMessage(message: JsonRpcMessage): Promise<void>
    {
        if (!this.connected)
        {
            return Promise.reject(new Error("MockTransport is not connected."));
        }

        this.sentMessages.push(message);

        if ("id" in message && message.id !== undefined && "method" in message && message.method === "account/rateLimits/read")
        {
            if (this.accountRateLimitsResult === undefined)
            {
                this.emitMessage({
                    id: message.id,
                    error: { code: -32_601, message: "Method not found: account/rateLimits/read" },
                });
            }
            else
            {
                this.emitMessage({ id: message.id, result: this.accountRateLimitsResult });
            }
        }

        return Promise.resolve();
    }

    async sendNotification(method: string, params?: unknown): Promise<void> 
    {
        await this.sendMessage(params === undefined ? { method } : { method, params });
    }

    on<K extends keyof CodexTransportEventMap>(
        event: K,
        listener: CodexTransportEventMap[K],
    ): () => void 
    {
        this.listeners[event].add(listener);

        return () => 
        {
            this.listeners[event].delete(listener);
        };
    }

    emitMessage(message: JsonRpcMessage): void 
    {
        this.emit("message", message);
    }

    emitError(error: unknown): void 
    {
        this.emit("error", error);
    }

    private emit<K extends keyof CodexTransportEventMap>(
        event: K,
        ...args: Parameters<CodexTransportEventMap[K]>
    ): void 
    {
        for (const listener of this.listeners[event]) 
        {
            (listener as (...listenerArgs: Parameters<CodexTransportEventMap[K]>) => void)(
                ...args,
            );
        }
    }
}
