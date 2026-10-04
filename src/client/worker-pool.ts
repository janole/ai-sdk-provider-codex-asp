import { CodexProviderError } from "../errors";
import type { TokenUsageBreakdown } from "../protocol/app-server-protocol/v2/TokenUsageBreakdown";
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
    private readonly lastUsageTotalByThreadId = new Map<string, TokenUsageBreakdown>();

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

        const worker = this.pickWorker(options?.threadId);

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

        // FIFO among the waiters this worker may serve: a thread owned by another worker keeps
        // waiting for its owner, and a reserved worker only serves its reserving thread.
        const index = this.waiters.findIndex(waiter => this.mayServe(worker, waiter.threadId));

        if (index >= 0)
        {
            const [waiter] = this.waiters.splice(index, 1);
            this.clearWaiterAbortHandler(waiter!); // prevent stale abort handler from firing after resolve
            waiter!.resolve(worker);
        }
        else
        {
            worker.release();
        }
    }

    /** Returns the last thread-cumulative usage regardless of which worker observed it. */
    getLastUsageTotal(threadId: string | undefined): TokenUsageBreakdown | null
    {
        return threadId === undefined ? null : this.lastUsageTotalByThreadId.get(threadId) ?? null;
    }

    /** Stores thread-cumulative usage for the next step, even when another worker resumes it. */
    setLastUsageTotal(threadId: string, total: TokenUsageBreakdown): void
    {
        this.lastUsageTotalByThreadId.set(threadId, total);
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
        this.lastUsageTotalByThreadId.clear();
    }

    /**
     * A thread already bound to a worker — by a parked tool call, or by being loaded in its live
     * process (Codex's writer lease) — runs only there, waiting while it is busy: any other worker's
     * `thread/resume` would fail with "already has an active writer". An unbound thread goes to the
     * available worker holding the fewest threads, so concurrent threads spread across processes
     * instead of queueing behind one another's owner.
     */
    private pickWorker(threadId: string | undefined): CodexWorker | undefined
    {
        const owner = threadId === undefined ? undefined : this.ownerOf(threadId);

        if (owner)
        {
            return isAvailable(owner) && this.mayServe(owner, threadId) ? owner : undefined;
        }

        let best: CodexWorker | undefined;

        for (const worker of this.workers)
        {
            if (!isAvailable(worker) || worker.pendingToolCall)
            {
                continue;
            }

            // A live idle worker beats spawning a process for an equally loaded empty slot.
            if (!best
                || worker.loadedThreadCount < best.loadedThreadCount
                || (worker.loadedThreadCount === best.loadedThreadCount && best.state === "disconnected" && worker.state === "idle"))
            {
                best = worker;
            }
        }

        return best;
    }

    private ownerOf(threadId: string): CodexWorker | undefined
    {
        return this.workers.find(w => w.pendingToolCall?.threadId === threadId)
            ?? this.workers.find(w => w.hasLoadedThread(threadId));
    }

    /** Ownership and reservation rules only; availability is the caller's concern. */
    private mayServe(worker: CodexWorker, threadId: string | undefined): boolean
    {
        if (worker.pendingToolCall)
        {
            return worker.pendingToolCall.threadId === threadId;
        }

        const owner = threadId === undefined ? undefined : this.ownerOf(threadId);

        return !owner || owner === worker;
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

function isAvailable(worker: CodexWorker): boolean
{
    return worker.state === "idle" || worker.state === "disconnected";
}
