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
    signal?: AbortSignal;
}

interface AcquireWaiter
{
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

        const worker = this.workers.find(
            (w) => w.state === "idle" || w.state === "disconnected",
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
        // An aborted waiter can never appear here: the abort handler
        // synchronously removes it from the queue via removeWaiter(),
        // so shift() will only ever return live (non-aborted) waiters.
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
