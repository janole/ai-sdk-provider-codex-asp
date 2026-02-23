import { describe, expect, it } from "vitest";

import { AppServerClient } from "../src/client/app-server-client";
import { CODEX_PROVIDER_ID } from "../src/protocol/provider-metadata";
import type { JsonRpcMessage } from "../src/client/transport";
import { DynamicToolsDispatcher } from "../src/dynamic-tools";
import { createCodexAppServer } from "../src/provider";
import { MockTransport } from "./helpers/mock-transport";

class ScriptedDynamicTransport extends MockTransport
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
                    id: 77,
                    method: "item/tool/call",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        callId: "call_1",
                        tool: "lookup",
                        arguments: { id: "ABC-1" },
                    },
                });

                setTimeout(() =>
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
                            delta: "Done",
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
                }, 5);
            });
        }
    }
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]>
{
    const reader = stream.getReader();
    const values: unknown[] = [];

    while (true)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        values.push(value);
    }

    return values;
}

describe("DynamicToolsDispatcher", () =>
{
    it("executes registered handlers for inbound item/tool/call requests", async () =>
    {
        const transport = new MockTransport();
        const client = new AppServerClient(transport);
        const dispatcher = new DynamicToolsDispatcher({
            handlers: {
                lookup: (args) => Promise.resolve({
                    success: true,
                    contentItems: [{ type: "inputText", text: `ok:${JSON.stringify(args)}` }],
                }),
            },
            timeoutMs: 100,
        });

        await client.connect();
        dispatcher.attach(client);

        transport.emitMessage({
            id: 42,
            method: "item/tool/call",
            params: { tool: "lookup", arguments: { id: "ABC-1" } },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(transport.sentMessages.at(-1)).toEqual({
            id: 42,
            result: {
                success: true,
                contentItems: [{ type: "inputText", text: "ok:{\"id\":\"ABC-1\"}" }],
            },
        });
    });

    it("executes tools registered via the tools (schema) API", async () =>
    {
        const transport = new MockTransport();
        const client = new AppServerClient(transport);
        const dispatcher = new DynamicToolsDispatcher({
            tools: {
                lookup: {
                    description: "Look up a record by id.",
                    inputSchema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                        required: ["id"],
                    },
                    execute: (args) => Promise.resolve({
                        success: true,
                        contentItems: [{ type: "inputText", text: `schema:${JSON.stringify(args)}` }],
                    }),
                },
            },
            timeoutMs: 100,
        });

        await client.connect();
        dispatcher.attach(client);

        transport.emitMessage({
            id: 55,
            method: "item/tool/call",
            params: { tool: "lookup", arguments: { id: "XYZ" } },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(transport.sentMessages.at(-1)).toEqual({
            id: 55,
            result: {
                success: true,
                contentItems: [{ type: "inputText", text: "schema:{\"id\":\"XYZ\"}" }],
            },
        });
    });

    it("returns failure response when handler times out", async () =>
    {
        const dispatcher = new DynamicToolsDispatcher({
            handlers: {
                slow: async () =>
                    new Promise((resolve) =>
                    {
                        setTimeout(() => resolve({ success: true, contentItems: [] }), 100);
                    }),
            },
            timeoutMs: 10,
        });

        const result = await dispatcher.dispatch({ tool: "slow", arguments: {} });

        expect(result.success).toBe(false);
        expect(result.contentItems[0]).toEqual(
            expect.objectContaining({ type: "inputText" }),
        );
    });

    it("returns failure response when handler throws", async () =>
    {
        const dispatcher = new DynamicToolsDispatcher({
            handlers: {
                broken: () => Promise.reject(new Error("boom")),
            },
            timeoutMs: 100,
        });

        const result = await dispatcher.dispatch({ tool: "broken", arguments: {} });

        expect(result).toEqual({
            success: false,
            contentItems: [{ type: "inputText", text: "boom" }],
        });
    });

    it("returns failure response for unknown tool", async () =>
    {
        const dispatcher = new DynamicToolsDispatcher({ handlers: {} });

        const result = await dispatcher.dispatch({ tool: "missing", arguments: {} });

        expect(result.success).toBe(false);
        expect(result.contentItems[0]).toEqual(
            expect.objectContaining({ type: "inputText" }),
        );
    });
});

describe("CodexLanguageModel dynamic tools wiring", () =>
{
    it("routes inbound tool call through dispatcher during doStream", async () =>
    {
        const transport = new ScriptedDynamicTransport();

        const provider = createCodexAppServer({
            experimentalApi: true,
            transportFactory: () => transport,
            tools: {
                lookup: {
                    description: "Look up a record by id.",
                    inputSchema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                        required: ["id"],
                    },
                    execute: (args) => Promise.resolve({
                        success: true,
                        contentItems: [{ type: "inputText", text: `lookup:${JSON.stringify(args)}` }],
                    }),
                },
            },
            toolTimeoutMs: 100,
            clientInfo: { name: "test-client", version: "1.0.0" },
        });

        const model = provider.languageModel("gpt-5.1-codex");
        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        const parts = await readAll(stream);

        expect((parts as { type?: string }[]).find((part) => part.type === "text-delta")).toMatchObject({
            type: "text-delta",
            id: "item_1",
            delta: "Done",
            providerMetadata: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
        });

        const toolResponse = transport.sentMessages.find(
            (message) => "id" in message && message.id === 77,
        );

        expect(toolResponse).toEqual({
            id: 77,
            result: {
                success: true,
                contentItems: [{ type: "inputText", text: "lookup:{\"id\":\"ABC-1\"}" }],
            },
        });
    });

    it("includes dynamicTools definitions in thread/start params", async () =>
    {
        const transport = new ScriptedDynamicTransport();

        const provider = createCodexAppServer({
            experimentalApi: true,
            transportFactory: () => transport,
            tools: {
                lookup: {
                    description: "Look up a record by id.",
                    inputSchema: {
                        type: "object",
                        properties: { id: { type: "string" } },
                        required: ["id"],
                    },
                    execute: (args) => Promise.resolve({
                        success: true,
                        contentItems: [{ type: "inputText", text: `lookup:${JSON.stringify(args)}` }],
                    }),
                },
            },
            toolTimeoutMs: 100,
            clientInfo: { name: "test-client", version: "1.0.0" },
        });

        const model = provider.languageModel("gpt-5.1-codex");
        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        await readAll(stream);

        const threadStartMsg = transport.sentMessages.find(
            (m) => "method" in m && m.method === "thread/start",
        );

        expect(threadStartMsg).toBeDefined();
        expect((threadStartMsg as { params?: { dynamicTools?: unknown[] } }).params?.dynamicTools).toEqual([
            {
                name: "lookup",
                description: "Look up a record by id.",
                inputSchema: {
                    type: "object",
                    properties: { id: { type: "string" } },
                    required: ["id"],
                },
            },
        ]);
    });
});
