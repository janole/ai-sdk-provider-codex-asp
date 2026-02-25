import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import type { JsonRpcMessage } from "../src/client/transport";
import { CODEX_PROVIDER_ID } from "../src/protocol/provider-metadata";
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
            this.emitMessage({
                id: message.id,
                result: {
                    thread: {
                        id: "thr_1",
                        preview: "",
                        modelProvider: "openai",
                        createdAt: 0,
                        updatedAt: 0,
                        path: null,
                        cwd: "/tmp",
                        cliVersion: "test",
                        source: "appServer",
                        gitInfo: null,
                        turns: [],
                    },
                    model: "gpt-5.3-codex",
                    modelProvider: "openai",
                    cwd: "/tmp",
                    approvalPolicy: "never",
                    sandbox: { type: "dangerFullAccess" },
                    reasoningEffort: null,
                },
            });
            return;
        }

        if (message.method === "thread/compact/start")
        {
            this.emitMessage({ id: message.id, result: {} });
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
                        item: { type: "agentMessage", id: "item_1", text: "" },
                        threadId: "thr_1",
                        turnId: "turn_1",
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
                        item: { type: "agentMessage", id: "item_1", text: "Hello" },
                        threadId: "thr_1",
                        turnId: "turn_1",
                    },
                });
                this.emitMessage({
                    method: "turn/completed",
                    params: {
                        threadId: "thr_1",
                        turn: { id: "turn_1", items: [], status: "completed", error: null },
                    },
                });
            });
        }
    }
}

class CompactionFailingTransport extends ScriptedTransport
{
    override async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        if (!("id" in message) || message.id === undefined || !("method" in message))
        {
            await super.sendMessage(message);
            return;
        }

        if (message.method === "thread/compact/start")
        {
            await MockTransport.prototype.sendMessage.call(this, message);
            this.emitMessage({
                id: message.id,
                error: { code: -32000, message: "compaction failed" },
            });
            return;
        }

        await super.sendMessage(message);
    }
}

class InterruptAwareTransport extends MockTransport
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
            this.emitMessage({ id: message.id, result: { threadId: "thr_abort" } });
            return;
        }

        if (message.method === "turn/start")
        {
            this.emitMessage({ id: message.id, result: { turnId: "turn_abort" } });
            return;
        }

        if (message.method === "turn/interrupt")
        {
            this.emitMessage({ id: message.id, result: {} });
            return;
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

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        const parts = await readAll(stream);

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "text-start",
                id: "item_1",
                providerMetadata: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
            },
            {
                type: "text-delta",
                id: "item_1",
                delta: "Hello",
                providerMetadata: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
            },
            {
                type: "text-end",
                id: "item_1",
                providerMetadata: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
            },
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
                providerMetadata: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
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

    it("resumes an existing thread when providerMetadata carries a threadId", async () =>
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello" }],
                    providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_existing" } },
                },
                { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
        });

        await readAll(stream);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);

        const resumeMessage = transport.sentMessages.find(
            (message): message is { method: string; params?: unknown } =>
                "method" in message && message.method === "thread/resume",
        );
        expect(resumeMessage?.params).toMatchObject({ threadId: "thr_existing" });

        const turnStartMessage = transport.sentMessages.find(
            (message): message is { method: string; params?: unknown } =>
                "method" in message && message.method === "turn/start",
        );
        expect(turnStartMessage?.params).toMatchObject({
            input: [{ type: "text", text: "continue", text_elements: [] }],
        });
    });

    it("resumes a thread when threadId is on content-part providerOptions", async () =>
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "text",
                            text: "Hello",
                            providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_content_part" } },
                        },
                    ],
                },
                { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
        });

        await readAll(stream);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);

        const resumeMessage = transport.sentMessages.find(
            (message): message is { method: string; params?: unknown } =>
                "method" in message && message.method === "thread/resume",
        );
        expect(resumeMessage?.params).toMatchObject({ threadId: "thr_content_part" });
    });

    it("can compact a resumed thread before turn/start", async () =>
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            compaction: { shouldCompactOnResume: true },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello" }],
                    providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_existing" } },
                },
                { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
        });

        await readAll(stream);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual([
            "initialize",
            "initialized",
            "thread/resume",
            "thread/compact/start",
            "turn/start",
        ]);
    });

    it("continues when non-strict compaction fails", async () =>
    {
        const transport = new CompactionFailingTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            compaction: { shouldCompactOnResume: true },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello" }],
                    providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_existing" } },
                },
                { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
        });

        await readAll(stream);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual([
            "initialize",
            "initialized",
            "thread/resume",
            "thread/compact/start",
            "turn/start",
        ]);
    });

    it("supports callback-based compaction decision with resume context", async () =>
    {
        const transport = new ScriptedTransport();
        const shouldCompactOnResume = vi.fn<(context: unknown) => boolean>(() => true);

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            compaction: { shouldCompactOnResume },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const prompt: LanguageModelV3CallOptions["prompt"] = [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            {
                role: "assistant",
                content: [{ type: "text", text: "Hello" }],
                providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_existing" } },
            },
            { role: "user", content: [{ type: "text", text: "continue" }] },
        ];

        const { stream } = await model.doStream({ prompt });
        await readAll(stream);

        expect(shouldCompactOnResume).toHaveBeenCalledTimes(1);
        const firstCall = shouldCompactOnResume.mock.calls[0];
        expect(firstCall).toBeDefined();
        const typedCallbackContext = firstCall![0] as {
            threadId: string;
            resumeThreadId: string;
            resumeResult: { thread: { id: string } };
            prompt: unknown[];
        };
        expect(typedCallbackContext).toMatchObject({
            threadId: "thr_1",
            resumeThreadId: "thr_existing",
            resumeResult: { thread: { id: "thr_1" } },
        });
        expect(typedCallbackContext.prompt).toEqual(prompt);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual([
            "initialize",
            "initialized",
            "thread/resume",
            "thread/compact/start",
            "turn/start",
        ]);
    });

    it("skips compaction when callback returns false", async () =>
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            compaction: { shouldCompactOnResume: () => false },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello" }],
                    providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_existing" } },
                },
                { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
        });

        await readAll(stream);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual([
            "initialize",
            "initialized",
            "thread/resume",
            "turn/start",
        ]);
    });

    it("continues when callback throws in non-strict mode", async () =>
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            compaction: { shouldCompactOnResume: () => { throw new Error("decision failed"); } },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello" }],
                    providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_existing" } },
                },
                { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
        });

        await readAll(stream);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual([
            "initialize",
            "initialized",
            "thread/resume",
            "turn/start",
        ]);
    });

    it("fails before turn/start when callback throws in strict mode", async () =>
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            compaction: {
                shouldCompactOnResume: () => { throw new Error("decision failed"); },
                strict: true,
            },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello" }],
                    providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_existing" } },
                },
                { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
        });

        const parts = await readAll(stream);
        expect(parts.some((part) => (
            typeof part === "object"
            && part !== null
            && "type" in part
            && (part as { type: string }).type === "error"
        ))).toBe(true);

        const methods = transport.sentMessages
            .filter((message): message is { method: string } => "method" in message)
            .map((message) => message.method);

        expect(methods).toEqual([
            "initialize",
            "initialized",
            "thread/resume",
        ]);
    });

    it("passes system messages as developerInstructions on thread/start", async () =>
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "system", content: "Be concise." },
                { role: "user", content: [{ type: "text", text: "hello" }] },
            ],
        });

        await readAll(stream);

        const threadStartMessage = transport.sentMessages.find(
            (message): message is { method: string; params?: unknown } =>
                "method" in message && message.method === "thread/start",
        );
        expect(threadStartMessage?.params).toMatchObject({
            developerInstructions: "Be concise.",
        });

        const turnStartMessage = transport.sentMessages.find(
            (message): message is { method: string; params?: unknown } =>
                "method" in message && message.method === "turn/start",
        );
        expect(turnStartMessage?.params).toMatchObject({
            input: [{ type: "text", text: "hello", text_elements: [] }],
        });
    });

    it("passes defaultTurnSettings including rich sandboxPolicy on turn/start", async () =>
    {
        const transport = new ScriptedTransport();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            defaultTurnSettings: {
                approvalPolicy: "on-request",
                sandboxPolicy: {
                    type: "externalSandbox",
                    networkAccess: "enabled",
                },
            },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        await readAll(stream);

        const turnStartMessage = transport.sentMessages.find(
            (message): message is { method: string; params?: unknown } =>
                "method" in message && message.method === "turn/start",
        );

        expect(turnStartMessage?.params).toMatchObject({
            approvalPolicy: "on-request",
            sandboxPolicy: {
                type: "externalSandbox",
                networkAccess: "enabled",
            },
        });
    });

    it("emits debug events through the logger when logPackets is enabled", async () =>
    {
        const transport = new ScriptedTransport();
        const loggerSpy = vi.fn();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            debug: { logPackets: true, logger: loggerSpy },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        });

        await readAll(stream);

        const debugEvents = loggerSpy.mock.calls
            .map((call: unknown[]) => call[0] as { direction: string; message: unknown })
            .filter((packet) =>
                typeof packet.message === "object"
                && packet.message !== null
                && "debug" in packet.message,
            );

        const debugLabels = debugEvents.map(
            (e) => (e.message as { debug: string }).debug,
        );

        expect(debugLabels).toContain("prompt");
        expect(debugLabels).toContain("extractResumeThreadId");
        expect(debugLabels).toContain("thread/start");
        expect(debugLabels).toContain("turn/start");

        const promptEvent = debugEvents.find(
            (e) => (e.message as { debug: string }).debug === "prompt",
        );
        expect(promptEvent?.direction).toBe("inbound");

        const extractEvent = debugEvents.find(
            (e) => (e.message as { debug: string }).debug === "extractResumeThreadId",
        );
        expect(extractEvent?.direction).toBe("inbound");
        expect((extractEvent?.message as { data: unknown }).data).toEqual({
            resumeThreadId: undefined,
        });

        const threadStartEvent = debugEvents.find(
            (e) => (e.message as { debug: string }).debug === "thread/start",
        );
        expect(threadStartEvent?.direction).toBe("outbound");

        const turnStartEvent = debugEvents.find(
            (e) => (e.message as { debug: string }).debug === "turn/start",
        );
        expect(turnStartEvent?.direction).toBe("outbound");
        expect((turnStartEvent?.message as { data: { threadId: string } }).data).toMatchObject({
            threadId: "thr_1",
        });
    });

    it("emits thread/resume debug event when resuming a thread", async () =>
    {
        const transport = new ScriptedTransport();
        const loggerSpy = vi.fn();

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            debug: { logPackets: true, logger: loggerSpy },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "Hello" }],
                    providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_existing" } },
                },
                { role: "user", content: [{ type: "text", text: "continue" }] },
            ],
        });

        await readAll(stream);

        const debugEvents = loggerSpy.mock.calls
            .map((call: unknown[]) => call[0] as { direction: string; message: unknown })
            .filter((packet) =>
                typeof packet.message === "object"
                && packet.message !== null
                && "debug" in packet.message,
            );

        const debugLabels = debugEvents.map(
            (e) => (e.message as { debug: string }).debug,
        );

        expect(debugLabels).toContain("extractResumeThreadId");
        expect(debugLabels).toContain("thread/resume");
        expect(debugLabels).not.toContain("thread/start");

        const extractEvent = debugEvents.find(
            (e) => (e.message as { debug: string }).debug === "extractResumeThreadId",
        );
        expect((extractEvent?.message as { data: unknown }).data).toEqual({
            resumeThreadId: "thr_existing",
        });

        const resumeEvent = debugEvents.find(
            (e) => (e.message as { debug: string }).debug === "thread/resume",
        );
        expect(resumeEvent?.direction).toBe("outbound");
        expect((resumeEvent?.message as { data: { threadId: string } }).data).toMatchObject({
            threadId: "thr_existing",
        });
    });

    it("sends turn/interrupt when abortSignal is triggered after turn/start", async () =>
    {
        const transport = new InterruptAwareTransport();
        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
        });
        const model = provider.languageModel("gpt-5.3-codex");
        const abortController = new AbortController();

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "interrupt me" }] }],
            abortSignal: abortController.signal,
        });

        await new Promise(resolve => setTimeout(resolve, 0));
        abortController.abort();

        await readAll(stream);

        const interruptMessage = transport.sentMessages.find(
            (message): message is { method: string; params?: unknown } =>
                "method" in message && message.method === "turn/interrupt",
        );
        expect(interruptMessage).toBeDefined();
        expect(interruptMessage?.params).toMatchObject({
            threadId: "thr_abort",
            turnId: "turn_abort",
        });
    });
});
