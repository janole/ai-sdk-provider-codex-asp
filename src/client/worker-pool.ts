import { CodexProviderError } from "../errors";
import type { CodexTransport } from "./transport";
import { CodexWorker } from "./worker";

export interface CodexWorkerPoolSettings
{
    poolSize?: number;
    transportFactory: () => CodexTransport;
    idleTimeoutMs?: number;
}

interface AcquireOptions
{
    threadId?: string;
    signal?: AbortSignal;
}

interface AcquireWaiter
{
    threadId: string | undefined;
    resolve: (worker: CodexWorker) => void;
    reject: (error: Error) => void;
    signal: AbortSignal | undefined;
    abortHandler: (() => void) | undefined;
}

export class CodexWorkerPool
{
    private readonly workers: CodexWorker[];
    private shutdownCalled = false;
    private readonly waiters: AcquireWaiter[] = [];

    constructor(settings: CodexWorkerPoolSettings)
    {
        const size = settings.poolSize ?? 1;
        const idleTimeoutMs = settings.idleTimeoutMs ?? 300_000;

        this.workers = Array.from({ length: size }, () =>
            new CodexWorker({
                transportFactory: settings.transportFactory,
                idleTimeoutMs,
            }),
        );
    }

    async acquire(options?: AcquireOptions): Promise<CodexWorker>
    {
        if (this.shutdownCalled)
        {
            throw new CodexProviderError("Worker pool has been shut down.");
        }

        // 1. Exact match: worker reserved for this thread's pending tool call
        if (options?.threadId)
        {
            const reserved = this.workers.find(
                (w) => (w.state === "idle" || w.state === "disconnected")
                    && w.pendingToolCall?.threadId === options.threadId,
            );

            if (reserved)
            {
                reserved.acquire();
                return reserved;
            }
        }

        // 2. Any unreserved worker (no pending tool call from another thread)
        const worker = this.workers.find(
            (w) => (w.state === "idle" || w.state === "disconnected")
                && !w.pendingToolCall,
        );

        if (!worker)
        {
            if (options?.signal?.aborted)
            {
                throw new CodexProviderError("Worker acquisition aborted while waiting.");
            }

            return new Promise<CodexWorker>((resolve, reject) =>
            {
                const waiter: AcquireWaiter = {
                    threadId: options?.threadId,
                    resolve,
                    reject,
                    signal: options?.signal,
                    abortHandler: undefined,
                };

                if (waiter.signal)
                {
                    waiter.abortHandler = () =>
                    {
                        this.removeWaiter(waiter);
                        waiter.reject(new CodexProviderError("Worker acquisition aborted while waiting."));
                    };
                    waiter.signal.addEventListener("abort", waiter.abortHandler, { once: true });
                }

                this.waiters.push(waiter);
            });
        }

        worker.acquire();
        return worker;
    }

    release(worker: CodexWorker): void
    {
        // Always clear session listeners from the previous session before
        // reuse, even during direct FIFO handoff.  Without this, stale
        // listeners can leak onto the underlying transport when the
        // higher-level disconnect path didn't (or couldn't) clean up.
        worker.clearSessionListeners();

        // An aborted waiter can never appear here: the abort handler
        // synchronously removes it from the queue via removeWaiter(),
        // so shift() will only ever return live (non-aborted) waiters.

        // Try to match a waiter that needs this specific worker's pending tool call
        if (worker.pendingToolCall)
        {
            const idx = this.waiters.findIndex(w => w.threadId === worker.pendingToolCall?.threadId);
            if (idx >= 0)
            {
                const [waiter] = this.waiters.splice(idx, 1);
                this.clearWaiterAbortHandler(waiter!);
                waiter!.resolve(worker);
                return;
            }
        }

        // Otherwise: existing FIFO behavior
        const waiter = this.waiters.shift();
        if (waiter)
        {
            this.clearWaiterAbortHandler(waiter); // prevent stale abort handler from firing after resolve
            waiter.resolve(worker);
        }
        else
        {
            worker.release();
        }
    }

    async shutdown(): Promise<void>
    {
        this.shutdownCalled = true;
        while (this.waiters.length > 0)
        {
            const waiter = this.waiters.shift()!;
            this.clearWaiterAbortHandler(waiter);
            waiter.reject(new CodexProviderError("Worker pool has been shut down."));
        }
        await Promise.all(this.workers.map((w) => w.shutdown()));
    }

    private removeWaiter(target: AcquireWaiter): void
    {
        const index = this.waiters.indexOf(target);
        if (index >= 0)
        {
            this.waiters.splice(index, 1);
        }
    }

    /** Remove the abort listener so it doesn't fire after the waiter is already served. */
    private clearWaiterAbortHandler(waiter: AcquireWaiter): void
    {
        if (!waiter.signal || !waiter.abortHandler)
        {
            return;
        }
        waiter.signal.removeEventListener("abort", waiter.abortHandler);
        waiter.abortHandler = undefined;
    }
}
