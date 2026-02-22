import { CodexProviderError } from "../errors";
import type { CodexTransport } from "./transport";
import { CodexWorker } from "./worker";

export interface CodexWorkerPoolSettings {
    poolSize?: number;
    transportFactory: () => CodexTransport;
    idleTimeoutMs?: number;
}

export class CodexWorkerPool
{
    private readonly workers: CodexWorker[];
    private shutdownCalled = false;

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

    acquire(): CodexWorker
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
            throw new CodexProviderError(
                "All workers are busy. Try again later or increase poolSize.",
            );
        }

        worker.acquire();
        return worker;
    }

    release(worker: CodexWorker): void
    {
        worker.release();
    }

    async shutdown(): Promise<void>
    {
        this.shutdownCalled = true;
        await Promise.all(this.workers.map((w) => w.shutdown()));
    }
}
