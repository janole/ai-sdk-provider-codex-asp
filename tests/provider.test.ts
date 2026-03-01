import { NoSuchModelError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { CODEX_PROVIDER_ID } from "../src";
import type { JsonRpcMessage } from "../src/client/transport";
import { CodexLanguageModel } from "../src/model";
import { createCodexAppServer } from "../src/provider";
import type { CodexSession } from "../src/session";
import { MockTransport } from "./helpers/mock-transport";

class ScriptedTransport extends MockTransport
{
    pauseTurnCompletion = false;

    completeTurn(): void
    {
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
    }

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

        if (message.method === "model/list")
        {
            this.emitMessage({
                id: message.id,
                result: {
                    data: [
                        {
                            id: "gpt-5.3-codex",
                            model: "gpt-5.3-codex",
                            upgrade: null,
                            displayName: "GPT-5.3 Codex",
                            description: "Test model",
                            hidden: false,
                            supportedReasoningEfforts: [
                                { reasoningEffort: "medium", description: "Default" },
                            ],
                            defaultReasoningEffort: "medium",
                            inputModalities: ["text", "image"],
                            supportsPersonality: false,
                            isDefault: true,
                        },
                    ],
                    nextCursor: null,
                },
            });
            return;
        }

        if (message.method === "turn/steer")
        {
            this.emitMessage({ id: message.id, result: { turnId: "turn_1" } });
            return;
        }

        if (message.method === "turn/interrupt")
        {
            this.emitMessage({ id: message.id, result: {} });
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
                        delta: "ok",
                    },
                });

                if (!this.pauseTurnCompletion)
                {
                    this.completeTurn();
                }
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

describe("createCodexAppServer", () => 
{
    it("creates provider with v3 specification and language model factory", () => 
    {
        const provider = createCodexAppServer({
            clientInfo: { name: "test", version: "0.1.0" },
            experimentalApi: true,
        });

        expect(provider.specificationVersion).toBe("v3");

        const model = provider.languageModel("gpt-5.3-codex");
        expect(model).toBeInstanceOf(CodexLanguageModel);
        expect(model.specificationVersion).toBe("v3");
        expect(model.provider).toBe(CODEX_PROVIDER_ID);
        expect(model.modelId).toBe("gpt-5.3-codex");
    });

    it("supports callable provider and chat alias", () => 
    {
        const provider = createCodexAppServer();

        const viaCall = provider("gpt-5.3-codex");
        const viaChat = provider.chat("gpt-5.3-codex");

        expect(viaCall).toBeInstanceOf(CodexLanguageModel);
        expect(viaChat).toBeInstanceOf(CodexLanguageModel);
    });

    it("throws NoSuchModelError for embedding and image models", () => 
    {
        const provider = createCodexAppServer();

        expect(() => provider.embeddingModel("embed-model")).toThrowError(
            NoSuchModelError,
        );
        expect(() => provider.imageModel("image-model")).toThrowError(
            NoSuchModelError,
        );
    });

    it("uses separate persistent pools by default", async () =>
    {
        const transports: ScriptedTransport[] = [];
        let factoryCalls = 0;
        const factory = () =>
        {
            factoryCalls++;
            const transport = new ScriptedTransport();
            transports.push(transport);
            return transport;
        };

        const providerOne = createCodexAppServer({
            transportFactory: factory,
            persistent: { poolSize: 1 },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });
        const providerTwo = createCodexAppServer({
            transportFactory: factory,
            persistent: { poolSize: 1 },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        try
        {
            const modelOne = providerOne.languageModel("gpt-5.3-codex");
            const modelTwo = providerTwo.languageModel("gpt-5.3-codex");

            const { stream: streamOne } = await modelOne.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "first" }] }],
            });
            await readAll(streamOne);

            const { stream: streamTwo } = await modelTwo.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "second" }] }],
            });
            await readAll(streamTwo);

            const initializeCount = transports
                .flatMap((transport) => transport.sentMessages)
                .filter((msg) => "method" in msg && msg.method === "initialize")
                .length;

            expect(factoryCalls).toBe(2);
            expect(initializeCount).toBe(2);
        }
        finally
        {
            await providerOne.shutdown();
            await providerTwo.shutdown();
        }
    });

    it("shares a global persistent pool when configured", async () =>
    {
        const transports: ScriptedTransport[] = [];
        let factoryCalls = 0;
        const factory = () =>
        {
            factoryCalls++;
            const transport = new ScriptedTransport();
            transports.push(transport);
            return transport;
        };

        const providerOne = createCodexAppServer({
            transportFactory: factory,
            persistent: { scope: "global", key: "provider-test-shared", poolSize: 1 },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });
        const providerTwo = createCodexAppServer({
            transportFactory: factory,
            persistent: { scope: "global", key: "provider-test-shared", poolSize: 1 },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        try
        {
            const modelOne = providerOne.languageModel("gpt-5.3-codex");
            const modelTwo = providerTwo.languageModel("gpt-5.3-codex");

            const { stream: streamOne } = await modelOne.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "first" }] }],
            });
            await readAll(streamOne);

            await providerOne.shutdown();

            const { stream: streamTwo } = await modelTwo.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "second" }] }],
            });
            await readAll(streamTwo);

            const initializeCount = transports
                .flatMap((transport) => transport.sentMessages)
                .filter((msg) => "method" in msg && msg.method === "initialize")
                .length;

            expect(factoryCalls).toBe(1);
            expect(initializeCount).toBe(1);
        }
        finally
        {
            await providerTwo.shutdown();
        }
    });

    it("listModels returns models via model/list RPC", async () =>
    {
        const provider = createCodexAppServer({
            transportFactory: () => new ScriptedTransport(),
            clientInfo: { name: "test-client", version: "1.0.0" },
        });

        const models = await provider.listModels();

        expect(models).toHaveLength(1);
        expect(models[0]).toMatchObject({
            id: "gpt-5.3-codex",
            displayName: "GPT-5.3 Codex",
            isDefault: true,
            inputModalities: ["text", "image"],
        });
    });

    it("onSessionCreated provides active session with threadId and turnId", async () =>
    {
        const transport = new ScriptedTransport();
        let capturedSession: CodexSession | null = null;
        let wasActiveDuringCallback = false;

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            onSessionCreated: (session) =>
            {
                capturedSession = session;
                wasActiveDuringCallback = session.isActive();
            },
        });

        const model = provider.languageModel("gpt-5.3-codex");
        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        });
        await readAll(stream);

        expect(capturedSession).not.toBeNull();
        expect(capturedSession!.threadId).toBe("thr_1");
        expect(capturedSession!.turnId).toBe("turn_1");
        expect(wasActiveDuringCallback).toBe(true);
    });

    it("session.injectMessage sends turn/steer RPC to the live connection", async () =>
    {
        const transport = new ScriptedTransport();
        transport.pauseTurnCompletion = true;
        let capturedSession: CodexSession | null = null;

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            onSessionCreated: (session) =>
            {
                capturedSession = session;
            },
        });

        const model = provider.languageModel("gpt-5.3-codex");
        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        });

        // Wait for session to be created (turn/start completes in microtask)
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(capturedSession).not.toBeNull();
        expect(capturedSession!.isActive()).toBe(true);

        await capturedSession!.injectMessage("Also add error handling");

        const steerMessage = transport.sentMessages.find(
            (msg): msg is { method: string; params?: unknown } =>
                "method" in msg && msg.method === "turn/steer",
        );
        expect(steerMessage?.params).toMatchObject({
            threadId: "thr_1",
            expectedTurnId: "turn_1",
            input: [{ type: "text", text: "Also add error handling", text_elements: [] }],
        });

        // Complete the turn so the stream closes cleanly
        transport.completeTurn();
        await readAll(stream);
    });

    it("session.interrupt sends turn/interrupt RPC to the live connection", async () =>
    {
        const transport = new ScriptedTransport();
        transport.pauseTurnCompletion = true;
        let capturedSession: CodexSession | null = null;

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            onSessionCreated: (session) =>
            {
                capturedSession = session;
            },
        });

        const model = provider.languageModel("gpt-5.3-codex");
        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        });

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(capturedSession).not.toBeNull();

        await capturedSession!.interrupt();

        const interruptMessage = transport.sentMessages.find(
            (msg): msg is { method: string; params?: unknown } =>
                "method" in msg && msg.method === "turn/interrupt",
        );
        expect(interruptMessage?.params).toMatchObject({
            threadId: "thr_1",
            turnId: "turn_1",
        });

        // Complete the turn so the stream closes cleanly
        transport.completeTurn();
        await readAll(stream);
    });

    it("throws when reusing a global key with different pool settings", async () =>
    {
        const providerOne = createCodexAppServer({
            transportFactory: () => new ScriptedTransport(),
            persistent: {
                scope: "global",
                key: "provider-test-mismatch",
                poolSize: 1,
                idleTimeoutMs: 60_000,
            },
            clientInfo: { name: "test-client", version: "1.0.0" },
            experimentalApi: true,
        });

        try
        {
            expect(() =>
                createCodexAppServer({
                    transportFactory: () => new ScriptedTransport(),
                    persistent: {
                        scope: "global",
                        key: "provider-test-mismatch",
                        poolSize: 2,
                        idleTimeoutMs: 60_000,
                    },
                }),
            ).toThrow(/already exists with different settings/i);
        }
        finally
        {
            await providerOne.shutdown();
        }
    });
});
