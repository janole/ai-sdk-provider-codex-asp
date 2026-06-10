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
    /** Provider-executed tool calls (e.g. parallel exec commands) still awaiting item/completed when the step closed. */
    openProviderToolCalls?: Array<{ itemId: string; toolName: string }>;
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
    private bufferedMessages: JsonRpcMessage[] = [];

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

        // While a tool call is parked and no session is attached (the gap
        // between two doStream() steps), inbound messages would otherwise be
        // dropped — e.g. item/completed of exec commands that were still
        // running when the step closed. Buffer them for replay on resume.
        this.inner.on("message", (message) =>
        {
            if (this.pendingToolCall && this.sessionListeners.length === 0)
            {
                this.bufferedMessages.push(message);
            }
        });

        this.inner.on("close", () =>
        {
            this.initialized = false;
            this.initializeResult = undefined;
            this.inner = null;
            this.state = "disconnected";
            this.bufferedMessages = [];
        });

        this.inner.on("error", () =>
        {
            this.initialized = false;
            this.initializeResult = undefined;
            this.inner = null;
            this.state = "disconnected";
            this.bufferedMessages = [];
        });

        await this.inner.connect();
    }

    acquire(): void
    {
        this.clearSessionListeners();
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

        if (!this.pendingToolCall)
        {
            this.bufferedMessages = [];
        }

        if (this.settings.idleTimeoutMs > 0)
        {
            this.idleTimer = setTimeout(() =>
            {
                void this.shutdown();
            }, this.settings.idleTimeoutMs);
        }
    }

    /** Returns and clears messages buffered while a tool call was parked with no session attached. */
    drainBufferedMessages(): JsonRpcMessage[]
    {
        return this.bufferedMessages.splice(0);
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
        this.bufferedMessages = [];

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
