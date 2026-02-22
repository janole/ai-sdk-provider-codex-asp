import { describe, expect, it } from "vitest";

import type { JsonRpcMessage } from "../src/client/transport";
import { PersistentTransport } from "../src/client/transport-persistent";
import { CodexWorkerPool } from "../src/client/worker-pool";
import { createCodexAppServer } from "../src/provider";
import { MockTransport } from "./helpers/mock-transport";

class ScriptedTransport extends MockTransport
{
    override async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        await super.sendMessage(message);

        if (!("id" in message) || message.id === undefined || !("method" in message))
        {
            return;
        }

        if (message.method === "initialize")
        {
            this.emitMessage({ id: message.id, result: { serverInfo: { name: "codex", version: "test" } } });
            return;
        }

        if (message.method === "thread/start")
        {
            this.emitMessage({ id: message.id, result: { threadId: "thr_1" } });
            return;
        }

        if (message.method === "thread/resume")
        {
            this.emitMessage({ id: message.id, result: { threadId: "thr_1" } });
            return;
        }

        if (message.method === "turn/start")
        {
            this.emitMessage({ id: message.id, result: { turnId: "turn_1" } });

            queueMicrotask(() =>
            {
                this.emitMessage({
                    method: "turn/started",
                    params: { threadId: "thr_1", turnId: "turn_1" },
                });
                this.emitMessage({
                    method: "item/started",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        itemType: "assistantMessage",
                    },
                });
                this.emitMessage({
                    method: "item/agentMessage/delta",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        delta: "Hello",
                    },
                });
                this.emitMessage({
                    method: "item/completed",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        itemType: "assistantMessage",
                    },
                });
                this.emitMessage({
                    method: "turn/completed",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        status: "completed",
                    },
                });
            });
        }
    }
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]>
{
    const reader = stream.getReader();
    const parts: unknown[] = [];

    while (true)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        parts.push(value);
    }

    return parts;
}

describe("PersistentTransport", () =>
{
    it("sends initialize only once across two sequential doStream calls", async () =>
    {
        const innerTransport = new ScriptedTransport();
        let factoryCalls = 0;

        const provider = createCodexAppServer({
            transportFactory: () =>
            {
                factoryCalls++;
                return innerTransport;
            },
            persistent: { poolSize: 1 },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        const model = provider.languageModel("gpt-5.1-codex");

        // First call
        const { stream: stream1 } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });
        await readAll(stream1);

        // Second call
        const { stream: stream2 } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello again" }] }],
        });
        await readAll(stream2);

        const initializeMessages = innerTransport.sentMessages.filter(
            (msg): msg is { method: string } =>
                "method" in msg && msg.method === "initialize",
        );

        expect(initializeMessages).toHaveLength(1);
        expect(factoryCalls).toBe(1);

        await provider.shutdown();
    });

    it("synthesizes initialize response with correct request id", async () =>
    {
        const innerTransport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => innerTransport,
            persistent: { poolSize: 1 },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        const model = provider.languageModel("gpt-5.1-codex");

        // First call — real initialize
        const { stream: stream1 } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });
        await readAll(stream1);

        // Second call — synthetic initialize
        const { stream: stream2 } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        });
        const parts = await readAll(stream2);

        // The second stream should complete successfully with text
        const textDeltas = (parts as { type: string; delta?: string }[]).filter(
            (p) => p.type === "text-delta",
        );
        expect(textDeltas).toHaveLength(1);
        expect(textDeltas[0]?.delta).toBe("Hello");

        // The second call should NOT have sent initialize to the inner transport
        const allMethods = innerTransport.sentMessages
            .filter((msg): msg is { method: string } => "method" in msg)
            .map((msg) => msg.method);

        // First call: initialize, initialized, thread/start, turn/start
        // Second call: thread/start, turn/start (no initialize, no initialized)
        expect(allMethods).toEqual([
            "initialize",
            "initialized",
            "thread/start",
            "turn/start",
            "thread/start",
            "turn/start",
        ]);

        await provider.shutdown();
    });

    it("recovers after inner transport crash by re-initializing", async () =>
    {
        let transportInstance: ScriptedTransport | null = null;
        let factoryCalls = 0;

        const provider = createCodexAppServer({
            transportFactory: () =>
            {
                factoryCalls++;
                transportInstance = new ScriptedTransport();
                return transportInstance;
            },
            persistent: { poolSize: 1 },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        const model = provider.languageModel("gpt-5.1-codex");

        // First call
        const { stream: stream1 } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });
        await readAll(stream1);

        expect(factoryCalls).toBe(1);
        const firstTransport = transportInstance!;

        // Simulate crash — disconnect the inner transport
        await firstTransport.disconnect();

        // Second call — should spawn a new transport and re-initialize
        const { stream: stream2 } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi again" }] }],
        });
        await readAll(stream2);

        expect(factoryCalls).toBe(2);

        // The second transport should have received initialize
        const secondTransport = transportInstance!;
        const methods = secondTransport.sentMessages
            .filter((msg): msg is { method: string } => "method" in msg)
            .map((msg) => msg.method);
        expect(methods).toContain("initialize");

        await provider.shutdown();
    });

    it("throws when pool is exhausted", async () =>
    {
        const pool = new CodexWorkerPool({
            poolSize: 1,
            transportFactory: () => new ScriptedTransport(),
        });

        const t1 = new PersistentTransport({ pool });
        const t2 = new PersistentTransport({ pool });

        // First acquire succeeds (via connect)
        await t1.connect();

        // Second acquire should throw
        await expect(() => t2.connect()).rejects.toThrow(/busy/i);

        await pool.shutdown();
    });

    it("does not send initialized notification on subsequent calls", async () =>
    {
        const innerTransport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => innerTransport,
            persistent: { poolSize: 1 },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        const model = provider.languageModel("gpt-5.1-codex");

        // First call
        const { stream: stream1 } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });
        await readAll(stream1);

        // Second call
        const { stream: stream2 } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        });
        await readAll(stream2);

        const initializedNotifications = innerTransport.sentMessages.filter(
            (msg) => "method" in msg && msg.method === "initialized",
        );

        expect(initializedNotifications).toHaveLength(1);

        await provider.shutdown();
    });
});
