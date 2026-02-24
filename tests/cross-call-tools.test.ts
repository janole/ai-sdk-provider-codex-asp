import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import type { JsonRpcMessage } from "../src/client/transport";
import { PersistentTransport } from "../src/client/transport-persistent";
import { CodexWorkerPool } from "../src/client/worker-pool";
import { CODEX_PROVIDER_ID } from "../src/protocol/provider-metadata";
import { createCodexAppServer } from "../src/provider";
import { MockTransport } from "./helpers/mock-transport";

/**
 * Scripted tool call definition for the mock transport.
 */
interface ScriptedToolCall
{
    callId: string;
    tool: string;
    args: Record<string, unknown>;
    argsJson: string;
}

/**
 * A MockTransport that scripts a sequence of Codex tool calls.
 *
 * On turn/start it emits the first tool call. Each time a tool call response
 * arrives it either emits the next tool call or finishes with an assistant
 * message + turn/completed.
 */
class ToolCallTransport extends MockTransport
{
    private readonly toolCalls: ScriptedToolCall[];
    private readonly finalMessage: string;
    private currentToolIndex = 0;
    private nextRequestId = 200;
    private currentRequestId = 200;

    constructor(toolCalls: ScriptedToolCall[], finalMessage: string)
    {
        super();
        this.toolCalls = toolCalls;
        this.finalMessage = finalMessage;
    }

    override async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        await super.sendMessage(message);

        if (!("id" in message) || message.id === undefined || !("method" in message))
        {
            if ("id" in message && "result" in message && message.id === this.currentRequestId)
            {
                this.handleToolCallResponse();
            }
            return;
        }

        const request = message;

        if (request.method === "initialize")
        {
            this.emitMessage({ id: request.id, result: { serverInfo: { name: "codex", version: "test" } } });
            return;
        }

        if (request.method === "thread/start")
        {
            this.emitMessage({ id: request.id, result: { threadId: "thr_1" } });
            return;
        }

        if (request.method === "thread/resume")
        {
            this.emitMessage({ id: request.id, result: { threadId: "thr_1" } });
            return;
        }

        if (request.method === "turn/start")
        {
            this.emitMessage({ id: request.id, result: { turnId: "turn_1" } });

            queueMicrotask(() =>
            {
                this.emitMessage({
                    method: "turn/started",
                    params: { threadId: "thr_1", turnId: "turn_1" },
                });
                this.emitNextToolCall();
            });
        }
    }

    private emitNextToolCall(): void
    {
        const tc = this.toolCalls[this.currentToolIndex];
        if (!tc)
        {
            return;
        }

        this.currentRequestId = this.nextRequestId++;

        this.emitMessage({
            method: "item/tool/callStarted",
            params: { callId: tc.callId, tool: tc.tool },
        });
        this.emitMessage({
            method: "item/tool/callDelta",
            params: { callId: tc.callId, delta: tc.argsJson },
        });
        this.emitMessage({
            method: "item/tool/callFinished",
            params: { callId: tc.callId },
        });
        this.emitMessage({
            id: this.currentRequestId,
            method: "item/tool/call",
            params: {
                threadId: "thr_1",
                turnId: "turn_1",
                callId: tc.callId,
                tool: tc.tool,
                arguments: tc.args,
            },
        });
    }

    private handleToolCallResponse(): void
    {
        this.currentToolIndex++;

        if (this.currentToolIndex < this.toolCalls.length)
        {
            // More tool calls to make — Codex calls the next tool
            queueMicrotask(() =>
            {
                this.emitNextToolCall();
            });
        }
        else
        {
            // All tools called — Codex produces final answer
            queueMicrotask(() =>
            {
                this.emitMessage({
                    method: "item/started",
                    params: { item: { type: "agentMessage", id: "item_msg", text: "" }, threadId: "thr_1", turnId: "turn_1" },
                });
                this.emitMessage({
                    method: "item/agentMessage/delta",
                    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_msg", delta: this.finalMessage },
                });
                this.emitMessage({
                    method: "item/completed",
                    params: { item: { type: "agentMessage", id: "item_msg", text: this.finalMessage }, threadId: "thr_1", turnId: "turn_1" },
                });
                this.emitMessage({
                    method: "turn/completed",
                    params: { threadId: "thr_1", turn: { id: "turn_1", items: [], status: "completed", error: null } },
                });
            });
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

type StreamPart = { type: string;[key: string]: unknown };

const TICKET_TOOL: ScriptedToolCall = {
    callId: "call_ticket",
    tool: "lookup_ticket",
    args: { id: "TICK-42" },
    argsJson: "{\"id\":\"TICK-42\"}",
};

const WEATHER_TOOL: ScriptedToolCall = {
    callId: "call_weather",
    tool: "check_weather",
    args: { location: "Berlin" },
    argsJson: "{\"location\":\"Berlin\"}",
};

const SDK_TOOLS: LanguageModelV3FunctionTool[] = [
    {
        type: "function",
        name: "lookup_ticket",
        description: "Look up the current status of a support ticket by its ID.",
        inputSchema: {
            type: "object",
            properties: { id: { type: "string", description: "The ticket ID." } },
            required: ["id"],
        },
    },
    {
        type: "function",
        name: "check_weather",
        description: "Get the current weather for a given location.",
        inputSchema: {
            type: "object",
            properties: { location: { type: "string", description: "City name." } },
            required: ["location"],
        },
    },
];

function createPersistentProvider(innerTransport: MockTransport)
{
    const pool = new CodexWorkerPool({
        poolSize: 1,
        transportFactory: () => innerTransport,
        idleTimeoutMs: 60_000,
    });

    return {
        pool,
        provider: createCodexAppServer({
            transportFactory: () => new PersistentTransport({ pool }),
            clientInfo: { name: "test", version: "1.0.0" },
        }),
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Cross-call tool support", () =>
{
    it("emits tool-call and finishes with tool-calls on first step", async () =>
    {
        const transport = new ToolCallTransport(
            [TICKET_TOOL],
            "Ticket TICK-42 is open.",
        );
        const { provider, pool } = createPersistentProvider(transport);

        try
        {
            const model = provider.languageModel("codex-test");

            const { stream } = await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Check ticket TICK-42" }] }],
                tools: SDK_TOOLS,
            });

            const parts = (await readAll(stream)) as StreamPart[];

            // Tool input streaming
            expect(parts.filter((p) => p.type === "tool-input-start")).toHaveLength(1);
            expect(parts.find((p) => p.type === "tool-input-start")?.toolName).toBe("lookup_ticket");

            // Tool call emitted
            const toolCalls = parts.filter((p) => p.type === "tool-call");
            expect(toolCalls).toHaveLength(1);
            expect(toolCalls[0]?.toolName).toBe("lookup_ticket");
            expect(toolCalls[0]?.toolCallId).toBe("call_ticket");

            // Finish reason = tool-calls
            const finish = parts.find((p) => p.type === "finish");
            expect((finish?.finishReason as { unified: string })?.unified).toBe("tool-calls");

            // threadId in providerMetadata
            const meta = finish?.providerMetadata as Record<string, Record<string, unknown>> | undefined;
            expect(meta?.[CODEX_PROVIDER_ID]?.threadId).toBe("thr_1");
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("resumes with tool result and completes (single tool)", async () =>
    {
        const transport = new ToolCallTransport(
            [TICKET_TOOL],
            "Ticket TICK-42 is open and assigned to team Alpha.",
        );
        const { provider, pool } = createPersistentProvider(transport);

        try
        {
            const model = provider.languageModel("codex-test");

            // Step 1: Codex calls lookup_ticket
            const { stream: s1 } = await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Check ticket TICK-42" }] }],
                tools: SDK_TOOLS,
            });
            await readAll(s1);

            // Step 2: SDK sends back the tool result
            const { stream: s2 } = await model.doStream({
                prompt: [
                    { role: "user", content: [{ type: "text", text: "Check ticket TICK-42" }] },
                    {
                        role: "assistant",
                        content: [
                            { type: "tool-call", toolCallId: "call_ticket", toolName: "lookup_ticket", input: { id: "TICK-42" } },
                        ],
                        providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
                    },
                    {
                        role: "tool",
                        content: [{
                            type: "tool-result",
                            toolCallId: "call_ticket",
                            toolName: "lookup_ticket",
                            output: { type: "text", value: "TICK-42: open, assigned to team Alpha" },
                        }],
                    },
                ],
            });

            const parts = (await readAll(s2)) as StreamPart[];

            const textDeltas = parts.filter((p) => p.type === "text-delta");
            expect(textDeltas.length).toBeGreaterThan(0);
            expect(textDeltas[0]?.delta).toBe("Ticket TICK-42 is open and assigned to team Alpha.");

            expect((parts.find((p) => p.type === "finish")?.finishReason as { unified: string })?.unified).toBe("stop");
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("handles multi-step: lookup_ticket → check_weather → final answer", async () =>
    {
        const transport = new ToolCallTransport(
            [TICKET_TOOL, WEATHER_TOOL],
            "TICK-42 is open (team Alpha). Weather in Berlin: 22°C, sunny.",
        );
        const { provider, pool } = createPersistentProvider(transport);

        try
        {
            const model = provider.languageModel("codex-test");

            // Step 1: Codex calls lookup_ticket
            const { stream: s1 } = await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Check TICK-42 and Berlin weather" }] }],
                tools: SDK_TOOLS,
            });
            const p1 = (await readAll(s1)) as StreamPart[];
            expect(p1.find((p) => p.type === "tool-call")?.toolName).toBe("lookup_ticket");
            expect((p1.find((p) => p.type === "finish")?.finishReason as { unified: string })?.unified).toBe("tool-calls");

            // Step 2: SDK returns ticket result → Codex calls check_weather
            const { stream: s2 } = await model.doStream({
                prompt: [
                    { role: "user", content: [{ type: "text", text: "Check TICK-42 and Berlin weather" }] },
                    {
                        role: "assistant",
                        content: [
                            { type: "tool-call", toolCallId: "call_ticket", toolName: "lookup_ticket", input: { id: "TICK-42" } },
                        ],
                        providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
                    },
                    {
                        role: "tool",
                        content: [{
                            type: "tool-result",
                            toolCallId: "call_ticket",
                            toolName: "lookup_ticket",
                            output: { type: "text", value: "TICK-42: open, team Alpha" },
                        }],
                    },
                ],
            });
            const p2 = (await readAll(s2)) as StreamPart[];
            expect(p2.find((p) => p.type === "tool-call")?.toolName).toBe("check_weather");
            expect((p2.find((p) => p.type === "finish")?.finishReason as { unified: string })?.unified).toBe("tool-calls");

            // Step 3: SDK returns weather result → Codex produces final answer
            const { stream: s3 } = await model.doStream({
                prompt: [
                    { role: "user", content: [{ type: "text", text: "Check TICK-42 and Berlin weather" }] },
                    {
                        role: "assistant",
                        content: [
                            { type: "tool-call", toolCallId: "call_ticket", toolName: "lookup_ticket", input: { id: "TICK-42" } },
                        ],
                        providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
                    },
                    {
                        role: "tool",
                        content: [{
                            type: "tool-result",
                            toolCallId: "call_ticket",
                            toolName: "lookup_ticket",
                            output: { type: "text", value: "TICK-42: open, team Alpha" },
                        }],
                    },
                    {
                        role: "assistant",
                        content: [
                            { type: "tool-call", toolCallId: "call_weather", toolName: "check_weather", input: { location: "Berlin" } },
                        ],
                        providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
                    },
                    {
                        role: "tool",
                        content: [{
                            type: "tool-result",
                            toolCallId: "call_weather",
                            toolName: "check_weather",
                            output: { type: "text", value: "Berlin: 22°C, sunny" },
                        }],
                    },
                ],
            });
            const p3 = (await readAll(s3)) as StreamPart[];

            // Final answer
            const textDeltas = p3.filter((p) => p.type === "text-delta");
            expect(textDeltas.length).toBeGreaterThan(0);
            expect(textDeltas[0]?.delta).toBe("TICK-42 is open (team Alpha). Weather in Berlin: 22°C, sunny.");

            expect((p3.find((p) => p.type === "finish")?.finishReason as { unified: string })?.unified).toBe("stop");
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("sends both tools as dynamicTools in thread/start", async () =>
    {
        const transport = new ToolCallTransport(
            [TICKET_TOOL],
            "Done.",
        );
        const { provider, pool } = createPersistentProvider(transport);

        try
        {
            const model = provider.languageModel("codex-test");

            const { stream } = await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
                tools: SDK_TOOLS,
            });
            await readAll(stream);

            const threadStart = transport.sentMessages.find(
                (msg) => "method" in msg && msg.method === "thread/start",
            ) as { params?: { dynamicTools?: Array<{ name: string }> } } | undefined;

            expect(threadStart?.params?.dynamicTools).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: "lookup_ticket" }),
                    expect.objectContaining({ name: "check_weather" }),
                ]),
            );
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("handles JSON tool result output", async () =>
    {
        const transport = new ToolCallTransport(
            [TICKET_TOOL],
            "Done.",
        );
        const { provider, pool } = createPersistentProvider(transport);

        try
        {
            const model = provider.languageModel("codex-test");

            const { stream: s1 } = await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
                tools: SDK_TOOLS,
            });
            await readAll(s1);

            const { stream: s2 } = await model.doStream({
                prompt: [
                    { role: "user", content: [{ type: "text", text: "test" }] },
                    {
                        role: "assistant",
                        content: [
                            { type: "tool-call", toolCallId: "call_ticket", toolName: "lookup_ticket", input: { id: "TICK-42" } },
                        ],
                        providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
                    },
                    {
                        role: "tool",
                        content: [{
                            type: "tool-result",
                            toolCallId: "call_ticket",
                            toolName: "lookup_ticket",
                            output: { type: "json", value: { status: "open", team: "Alpha" } },
                        }],
                    },
                ],
            });
            await readAll(s2);

            const toolResponse = transport.sentMessages.find(
                (msg) => "id" in msg && msg.id === 200 && "result" in msg,
            ) as { result?: { success: boolean; contentItems: Array<{ text: string }> } } | undefined;

            expect(toolResponse?.result?.success).toBe(true);
            expect(toolResponse?.result?.contentItems[0]?.text).toBe(
                JSON.stringify({ status: "open", team: "Alpha" }),
            );
        }
        finally
        {
            await pool.shutdown();
        }
    });
});
