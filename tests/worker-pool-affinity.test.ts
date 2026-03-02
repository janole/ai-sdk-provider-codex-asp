import { describe, expect, it } from "vitest";

import { CodexWorkerPool } from "../src/client/worker-pool";
import { MockTransport } from "./helpers/mock-transport";

describe("Worker pool thread affinity", () =>
{
    it("re-acquires the worker with matching pendingToolCall threadId", async () =>
    {
        const pool = new CodexWorkerPool({
            poolSize: 2,
            transportFactory: () => new MockTransport(),
            idleTimeoutMs: 60_000,
        });

        try
        {
            // Acquire both workers
            const workerA = await pool.acquire();
            const workerB = await pool.acquire();

            // Park tool calls on each worker with different threadIds
            workerA.pendingToolCall = {
                requestId: 1,
                callId: "call_a",
                toolName: "tool_a",
                args: {},
                threadId: "thread-A",
            };
            workerB.pendingToolCall = {
                requestId: 2,
                callId: "call_b",
                toolName: "tool_b",
                args: {},
                threadId: "thread-B",
            };

            // Release both back to the pool
            pool.release(workerA);
            pool.release(workerB);

            // Re-acquire with threadId hints — each should get its own worker back
            const reacquiredA = await pool.acquire({ threadId: "thread-A" });
            const reacquiredB = await pool.acquire({ threadId: "thread-B" });

            expect(reacquiredA).toBe(workerA);
            expect(reacquiredB).toBe(workerB);

            // Verify pending tool calls are still intact
            expect(reacquiredA.pendingToolCall?.threadId).toBe("thread-A");
            expect(reacquiredB.pendingToolCall?.threadId).toBe("thread-B");
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("does not steal a worker reserved for another thread", async () =>
    {
        const pool = new CodexWorkerPool({
            poolSize: 1,
            transportFactory: () => new MockTransport(),
            idleTimeoutMs: 60_000,
        });

        try
        {
            const worker = await pool.acquire();

            // Park a tool call for thread-A
            worker.pendingToolCall = {
                requestId: 1,
                callId: "call_a",
                toolName: "tool_a",
                args: {},
                threadId: "thread-A",
            };

            pool.release(worker);

            // Thread-B tries to acquire — should NOT get thread-A's worker
            // (it should queue as a waiter since there are no unreserved workers)
            let resolved = false;
            const acquirePromise = pool.acquire({ threadId: "thread-B" }).then((w) =>
            {
                resolved = true;
                return w;
            });

            // Give microtasks a chance to run
            await new Promise((r) => setTimeout(r, 10));
            expect(resolved).toBe(false);

            // Thread-A acquires its worker
            const reacquiredA = await pool.acquire({ threadId: "thread-A" });
            expect(reacquiredA).toBe(worker);

            // Clear pending and release — now thread-B can get it
            reacquiredA.pendingToolCall = null;
            pool.release(reacquiredA);

            const reacquiredB = await acquirePromise;
            expect(resolved).toBe(true);
            expect(reacquiredB).toBe(worker);
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("release matches waiters to workers with matching pending tool calls", async () =>
    {
        const pool = new CodexWorkerPool({
            poolSize: 2,
            transportFactory: () => new MockTransport(),
            idleTimeoutMs: 60_000,
        });

        try
        {
            // Acquire both workers and park tool calls
            const workerA = await pool.acquire();
            const workerB = await pool.acquire();

            workerA.pendingToolCall = {
                requestId: 1,
                callId: "call_a",
                toolName: "tool_a",
                args: {},
                threadId: "thread-A",
            };
            workerB.pendingToolCall = {
                requestId: 2,
                callId: "call_b",
                toolName: "tool_b",
                args: {},
                threadId: "thread-B",
            };

            // Both threads start waiting before any worker is released
            const promiseB = pool.acquire({ threadId: "thread-B" });
            const promiseA = pool.acquire({ threadId: "thread-A" });

            // Release workerA first — it should go to thread-A's waiter, not FIFO
            pool.release(workerA);
            const resultA = await promiseA;
            expect(resultA).toBe(workerA);

            // Release workerB — it should go to thread-B's waiter
            pool.release(workerB);
            const resultB = await promiseB;
            expect(resultB).toBe(workerB);
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("falls back to unreserved worker when no threadId is provided", async () =>
    {
        const pool = new CodexWorkerPool({
            poolSize: 2,
            transportFactory: () => new MockTransport(),
            idleTimeoutMs: 60_000,
        });

        try
        {
            const workerA = await pool.acquire();
            const workerB = await pool.acquire();

            // Only workerA has a pending tool call
            workerA.pendingToolCall = {
                requestId: 1,
                callId: "call_a",
                toolName: "tool_a",
                args: {},
                threadId: "thread-A",
            };

            pool.release(workerA);
            pool.release(workerB);

            // Acquire without threadId — should get workerB (unreserved), not workerA
            const acquired = await pool.acquire();
            expect(acquired).toBe(workerB);
        }
        finally
        {
            await pool.shutdown();
        }
    });
});
