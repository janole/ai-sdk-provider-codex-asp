import type {
    CodexTransport,
    CodexTransportEventMap,
    JsonRpcMessage,
} from "../../src/client/transport";

export class MockTransport implements CodexTransport 
{
    readonly sentMessages: JsonRpcMessage[] = [];

    private connected = false;
    private readonly listeners: {
        [K in keyof CodexTransportEventMap]: Set<CodexTransportEventMap[K]>;
    } = {
        message: new Set(),
        error: new Set(),
        close: new Set(),
    };

    async connect(): Promise<void> 
    {
        this.connected = true;
    }

    async disconnect(): Promise<void> 
    {
        this.connected = false;
        this.emit("close", null, null);
    }

    async sendMessage(message: JsonRpcMessage): Promise<void> 
    {
        if (!this.connected) 
        {
            throw new Error("MockTransport is not connected.");
        }

        this.sentMessages.push(message);
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
