import type {
    CodexTransport,
    CodexTransportEventMap,
    JsonRpcId,
    JsonRpcMessage,
} from "./transport";

export interface CodexWorkerSettings {
    transportFactory: () => CodexTransport;
    idleTimeoutMs: number;
}

export interface PendingToolCall {
    requestId: JsonRpcId;
    callId: string;
    toolName: string;
    args: unknown;
    threadId: string;
}

type SessionListenerEntry<K extends keyof CodexTransportEventMap> = {
    event: K;
    listener: CodexTransportEventMap[K];
    unsubscribe: () => void;
};

export class CodexWorker
{
    state: "idle" | "busy" | "disconnected" = "disconnected";
    initialized = false;
    initializeResult: unknown = undefined;
    pendingToolCall: PendingToolCall | null = null;

    private inner: CodexTransport | null = null;
    private readonly settings: CodexWorkerSettings;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private sessionListeners: SessionListenerEntry<any>[] = [];

    constructor(settings: CodexWorkerSettings)
    {
        this.settings = settings;
    }

    async ensureConnected(): Promise<void>
    {
        if (this.inner)
        {
            return;
        }

        this.inner = this.settings.transportFactory();

        this.inner.on("close", () =>
        {
            this.initialized = false;
            this.initializeResult = undefined;
            this.inner = null;
            this.state = "disconnected";
        });

        this.inner.on("error", () =>
        {
            this.initialized = false;
            this.initializeResult = undefined;
            this.inner = null;
            this.state = "disconnected";
        });

        await this.inner.connect();
    }

    acquire(): void
    {
        if (this.idleTimer)
        {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.state = "busy";
    }

    release(): void
    {
        this.clearSessionListeners();
        this.state = "idle";

        if (this.settings.idleTimeoutMs > 0)
        {
            this.idleTimer = setTimeout(() =>
            {
                void this.shutdown();
            }, this.settings.idleTimeoutMs);
        }
    }

    markInitialized(result: unknown): void
    {
        this.initialized = true;
        this.initializeResult = result;
    }

    onSession<K extends keyof CodexTransportEventMap>(
        event: K,
        listener: CodexTransportEventMap[K],
    ): () => void
    {
        if (!this.inner)
        {
            throw new Error("Worker has no active transport.");
        }

        const unsubscribe = this.inner.on(event, listener);
        this.sessionListeners.push({ event, listener, unsubscribe });
        return unsubscribe;
    }

    clearSessionListeners(): void
    {
        for (const entry of this.sessionListeners)
        {
            entry.unsubscribe();
        }
        this.sessionListeners = [];
    }

    async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        if (!this.inner)
        {
            throw new Error("Worker has no active transport.");
        }
        await this.inner.sendMessage(message);
    }

    async sendNotification(method: string, params?: unknown): Promise<void>
    {
        if (!this.inner)
        {
            throw new Error("Worker has no active transport.");
        }
        await this.inner.sendNotification(method, params);
    }

    async shutdown(): Promise<void>
    {
        if (this.idleTimer)
        {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        this.clearSessionListeners();

        if (this.inner)
        {
            const transport = this.inner;
            this.inner = null;
            this.initialized = false;
            this.initializeResult = undefined;
            this.state = "disconnected";
            await transport.disconnect();
        }
        else
        {
            this.state = "disconnected";
        }
    }
}
