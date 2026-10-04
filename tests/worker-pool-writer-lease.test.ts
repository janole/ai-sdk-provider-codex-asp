import { afterEach, describe, expect, it } from "vitest";

import type { CodexWorker } from "../src/client/worker";
import { CodexWorkerPool } from "../src/client/worker-pool";
import { MockTransport } from "./helpers/mock-transport";

// Codex >= 0.159 refuses `thread/resume` in one app-server process while another process
// has the thread loaded ("thread … already has an active writer"), so the pool must route
// every turn of a thread to the worker that loaded it.

let pool: CodexWorkerPool;
let transports: MockTransport[];
let requestId = 0;

function createPool(poolSize: number): CodexWorkerPool
{
    transports = [];
    pool = new CodexWorkerPool({
        poolSize,
        transportFactory: () =>
        {
            const transport = new MockTransport();
            transports.push(transport);
            return transport;
        },
        idleTimeoutMs: 60_000,
    });
    return pool;
}

async function acquireConnected(threadId?: string): Promise<CodexWorker>
{
    const worker = await pool.acquire(threadId === undefined ? undefined : { threadId });
    await worker.ensureConnected();
    return worker;
}

/** Sends `method` through the worker and answers it from the worker's transport. */
async function load(worker: CodexWorker, threadId: string, method = "thread/resume", fail = false): Promise<void>
{
    const transport = transports.at(-1)!;
    const id = ++requestId;
    await worker.sendMessage({ id, method, params: { threadId } });
    transport.emitMessage(fail
        ? { id, error: { code: -32_600, message: `thread ${threadId} already has an active writer` } }
        : { id, result: method === "thread/start" ? { threadId } : { thread: { id: threadId } } });
}

function settled<T>(promise: Promise<T>): { readonly done: boolean; readonly value: T | undefined }
{
    const state = { done: false, value: undefined as T | undefined };
    void promise.then(value =>
    {
        state.done = true;
        state.value = value;
    });
    return state;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

afterEach(async () =>
{
    await pool.shutdown();
});

describe("Worker pool writer-lease affinity", () =>
{
    it("returns a thread to the worker that loaded it, not the first idle one", async () =>
    {
        createPool(2);
        const first = await acquireConnected();
        const second = await acquireConnected();
        await load(second, "thread-1");
        pool.release(first);
        pool.release(second);

        expect(await pool.acquire({ threadId: "thread-1" })).toBe(second);
    });

    it("recognizes a thread loaded by thread/start", async () =>
    {
        createPool(2);
        const first = await acquireConnected();
        const second = await acquireConnected();
        await load(second, "thread-new", "thread/start");
        pool.release(first);
        pool.release(second);

        expect(await pool.acquire({ threadId: "thread-new" })).toBe(second);
    });

    it("waits for a busy owner instead of resuming the thread on another worker", async () =>
    {
        createPool(3);
        const owner = await acquireConnected();
        await load(owner, "thread-1");
        const other = await acquireConnected();

        const waiting = settled(pool.acquire({ threadId: "thread-1" }));
        await tick();
        expect(waiting.done).toBe(false);

        // Another worker coming free must not satisfy the owner's waiter.
        pool.release(other);
        await tick();
        expect(waiting.done).toBe(false);

        pool.release(owner);
        await tick();
        expect(waiting.value).toBe(owner);
    });

    it("places a new thread on a worker holding no threads", async () =>
    {
        createPool(2);
        const busyBefore = await acquireConnected();
        await load(busyBefore, "thread-1");
        pool.release(busyBefore);

        const placed = await pool.acquire();
        expect(placed).not.toBe(busyBefore);
    });

    it("releases ownership when the owning process dies", async () =>
    {
        createPool(2);
        const owner = await acquireConnected();
        await load(owner, "thread-1");
        transports[0]!.emitClose();

        const other = settled(pool.acquire({ threadId: "thread-1" }));
        await tick();
        expect(other.done).toBe(true);
    });

    it("does not bind a thread whose resume failed", async () =>
    {
        createPool(2);
        const first = await acquireConnected();
        const second = await acquireConnected();
        await load(second, "thread-1", "thread/resume", true);
        pool.release(first);
        pool.release(second);

        // Unbound: placement is free to pick the first (equally empty, live) worker.
        expect(await pool.acquire({ threadId: "thread-1" })).toBe(first);
    });
});
