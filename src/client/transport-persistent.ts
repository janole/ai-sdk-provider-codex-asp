import type { CodexToolCallResult } from "../protocol/types";
import type {
    CodexTransport,
    CodexTransportEventMap,
    JsonRpcMessage,
    JsonRpcSuccessResponse,
} from "./transport";
import type { PendingToolCall } from "./worker";
import type { CodexWorker } from "./worker";
import type { CodexWorkerPool } from "./worker-pool";

export interface PersistentTransportSettings {
    pool: CodexWorkerPool;
}

export class PersistentTransport implements CodexTransport
{
    private readonly pool: CodexWorkerPool;
    private worker: CodexWorker | null = null;
    private pendingInitializeId: string | number | null = null;
    private initializeIntercepted = false;

    private readonly messageListeners = new Set<(message: JsonRpcMessage) => void>();
    private readonly errorListeners = new Set<(error: unknown) => void>();
    private readonly closeListeners = new Set<
        (code: number | null, signal: NodeJS.Signals | null) => void
    >();

    constructor(settings: PersistentTransportSettings)
    {
        this.pool = settings.pool;
    }

    async connect(): Promise<void>
    {
        this.worker = this.pool.acquire();
        await this.worker.ensureConnected();
    }

    disconnect(): Promise<void>
    {
        if (this.worker)
        {
            const w = this.worker;
            this.worker = null;
            this.messageListeners.clear();
            this.errorListeners.clear();
            this.closeListeners.clear();
            this.pool.release(w);
        }
        return Promise.resolve();
    }

    async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        if (!this.worker)
        {
            throw new Error("PersistentTransport is not connected.");
        }

        if (isInitializeRequest(message))
        {
            if (this.worker.initialized)
            {
                this.initializeIntercepted = true;
                const requestId = message.id;
                const cachedResult = this.worker.initializeResult;

                queueMicrotask(() =>
                {
                    for (const listener of this.messageListeners)
                    {
                        listener({ id: requestId, result: cachedResult });
                    }
                });
                return;
            }

            this.initializeIntercepted = false;
            this.pendingInitializeId = message.id;
        }

        await this.worker.sendMessage(message);
    }

    async sendNotification(method: string, params?: unknown): Promise<void>
    {
        if (!this.worker)
        {
            throw new Error("PersistentTransport is not connected.");
        }

        if (method === "initialized" && this.initializeIntercepted)
        {
            return;
        }

        await this.worker.sendNotification(method, params);
    }

    on<K extends keyof CodexTransportEventMap>(
        event: K,
        listener: CodexTransportEventMap[K],
    ): () => void
    {
        if (!this.worker)
        {
            throw new Error("PersistentTransport is not connected.");
        }

        if (event === "message")
        {
            const msgListener = listener as (message: JsonRpcMessage) => void;

            const wrappedListener = ((incoming: JsonRpcMessage) =>
            {
                if (
                    this.pendingInitializeId !== null &&
                    "id" in incoming &&
                    incoming.id === this.pendingInitializeId &&
                    "result" in incoming
                )
                {
                    this.worker?.markInitialized(incoming.result);
                    this.pendingInitializeId = null;
                }
                msgListener(incoming);
            }) as CodexTransportEventMap[K];

            const workerUnsub = this.worker.onSession(event, wrappedListener);
            this.messageListeners.add(msgListener);

            return () =>
            {
                workerUnsub();
                this.messageListeners.delete(msgListener);
            };
        }

        if (event === "error")
        {
            const errListener = listener as (error: unknown) => void;
            const workerUnsub = this.worker.onSession(event, listener);
            this.errorListeners.add(errListener);

            return () =>
            {
                workerUnsub();
                this.errorListeners.delete(errListener);
            };
        }

        if (event === "close")
        {
            const closeListener = listener as (
                code: number | null,
                signal: NodeJS.Signals | null,
            ) => void;
            const workerUnsub = this.worker.onSession(event, listener);
            this.closeListeners.add(closeListener);

            return () =>
            {
                workerUnsub();
                this.closeListeners.delete(closeListener);
            };
        }

        return this.worker.onSession(event, listener);
    }

    getPendingToolCall(): PendingToolCall | null
    {
        return this.worker?.pendingToolCall ?? null;
    }

    async respondToToolCall(result: CodexToolCallResult): Promise<void>
    {
        if (!this.worker?.pendingToolCall)
        {
            throw new Error("No pending tool call to respond to.");
        }

        const { requestId } = this.worker.pendingToolCall;
        this.worker.pendingToolCall = null;

        await this.worker.sendMessage({
            id: requestId,
            result,
        } as JsonRpcSuccessResponse);
    }

    parkToolCall(pending: PendingToolCall): void
    {
        if (!this.worker)
        {
            throw new Error("PersistentTransport is not connected.");
        }
        this.worker.pendingToolCall = pending;
    }
}

function isInitializeRequest(
    message: JsonRpcMessage,
): message is { id: string | number; method: "initialize"; params?: unknown }
{
    return "id" in message && "method" in message && message.method === "initialize";
}
