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

/** Requests whose successful response leaves the thread loaded — and write-leased — in this app-server process. */
const THREAD_LOADING_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

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
    // Codex >= 0.159 holds a per-thread writer lease for as long as a thread stays loaded, and
    // neither `thread/unsubscribe` nor idling unloads it: only the process exiting does. A thread
    // loaded here therefore cannot be resumed by any other worker while this process lives.
    private readonly loadedThreads = new Set<string>();
    private readonly pendingThreadLoads = new Set<JsonRpcId>();

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

        const transport = this.settings.transportFactory();
        this.inner = transport;

        // While a tool call is parked and no session is attached (the gap
        // between two doStream() steps), inbound messages would otherwise be
        // dropped — e.g. item/completed of exec commands that were still
        // running when the step closed. Buffer them for replay on resume.
        transport.on("message", (message) =>
        {
            this.trackThreadLoad(message);

            if (this.pendingToolCall && this.sessionListeners.length === 0)
            {
                this.bufferedMessages.push(message);
            }
        });

        const handleTransportDeath = () =>
        {
            // A dead transport's handlers outlive it, so a late close from the
            // previous one must not tear down the replacement this worker has
            // since connected.
            if (this.inner !== transport)
            {
                return;
            }

            this.initialized = false;
            this.initializeResult = undefined;
            this.inner = null;
            this.state = "disconnected";
            this.bufferedMessages = [];
            this.loadedThreads.clear();
            this.pendingThreadLoads.clear();
            // `pendingToolCall` deliberately survives, even though its request id died
            // with the process and the pool now reserves this worker for a thread that
            // can never answer it. Clearing it is worse: the next step for that thread
            // takes the normal resume path, and `resolveResumed` keeps only the last
            // user message — so the tool result is dropped and the original prompt is
            // silently re-asked. Reclaiming the slot needs an abandonment record the
            // next step can refuse on, which is its own change.
        };

        transport.on("close", handleTransportDeath);
        transport.on("error", handleTransportDeath);

        await transport.connect();
    }

    acquire(): void
    {
        this.clearSessionListeners();
        this.pendingThreadLoads.clear();
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
        this.pendingThreadLoads.clear();
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

    /** Whether this worker's live app-server process has `threadId` loaded, and so holds its writer lease. */
    hasLoadedThread(threadId: string): boolean
    {
        return this.loadedThreads.has(threadId);
    }

    /** Number of threads loaded in this worker's live app-server process. */
    get loadedThreadCount(): number
    {
        return this.loadedThreads.size;
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

        if ("id" in message && "method" in message && THREAD_LOADING_METHODS.has(message.method))
        {
            this.pendingThreadLoads.add(message.id);
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
        this.loadedThreads.clear();
        this.pendingThreadLoads.clear();

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

    private trackThreadLoad(message: JsonRpcMessage): void
    {
        if (!("id" in message) || message.id === undefined || !this.pendingThreadLoads.delete(message.id) || !("result" in message))
        {
            return;
        }

        const threadId = loadedThreadId(message.result);

        if (threadId)
        {
            this.loadedThreads.add(threadId);
        }
    }
}

/** `thread/start` answers `{ threadId }` on older app servers and `{ thread: { id } }` on newer ones. */
function loadedThreadId(result: unknown): string | undefined
{
    if (typeof result !== "object" || result === null)
    {
        return undefined;
    }

    const { threadId, thread } = result as { threadId?: unknown; thread?: { id?: unknown } };
    const id = thread?.id ?? threadId;

    return typeof id === "string" ? id : undefined;
}
