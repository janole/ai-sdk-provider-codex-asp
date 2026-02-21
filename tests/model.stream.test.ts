import { describe, expect, it } from "vitest";

import type { JsonRpcMessage } from "../src/client/transport";
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

describe("CodexLanguageModel.doStream", () => 
{
    it("runs initialize -> thread/start -> turn/start and maps notifications to stream parts", async () => 
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        const model = provider.languageModel("gpt-5.1-codex");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        const parts = await readAll(stream);

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "item_1" },
            { type: "text-delta", id: "item_1", delta: "Hello" },
            { type: "text-end", id: "item_1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: {
                    inputTokens: {
                        total: undefined,
                        noCache: undefined,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                    },
                    outputTokens: {
                        total: undefined,
                        text: undefined,
                        reasoning: undefined,
                    },
                },
            },
        ]);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);

        const turnStartMessage = transport.sentMessages.find(
            (message): message is { method: string; params?: unknown } =>
                "method" in message && message.method === "turn/start",
        );
        expect(turnStartMessage).toBeDefined();
        expect(turnStartMessage?.params).toMatchObject({
            input: [{ type: "text", text: "hi", text_elements: [] }],
        });
    });
});
