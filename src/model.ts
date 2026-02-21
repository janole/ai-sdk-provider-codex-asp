import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3Content,
    LanguageModelV3GenerateResult,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";

import { AppServerClient } from "./client/app-server-client";
import type { CodexTransport } from "./client/transport";
import { StdioTransport, type StdioTransportSettings } from "./client/transport-stdio";
import {
    WebSocketTransport,
    type WebSocketTransportSettings,
} from "./client/transport-websocket";
import {
    type DynamicToolHandler,
    DynamicToolsDispatcher,
} from "./dynamic-tools";
import { CodexProviderError } from "./errors";
import { CodexEventMapper } from "./protocol/event-mapper";
import { mapPromptToTurnInput } from "./protocol/prompt-mapper";
import type {
    CodexInitializeParams,
    CodexInitializeResult,
    CodexThreadStartParams,
    CodexThreadStartResult,
    CodexTurnStartResult,
} from "./protocol/types";

export interface CodexLanguageModelSettings {
    // PR3 keeps model-level settings intentionally minimal.
}

export interface CodexThreadDefaults {
    cwd?: string;
    approvalMode?: "never" | "on-request" | "on-failure" | "untrusted";
    sandboxMode?: "read-only" | "workspace-write" | "full-access";
}

export interface CodexModelConfig {
    provider: string;
    providerSettings: {
        defaultModel?: string;
        clientInfo?: {
            name: string;
            version: string;
            title?: string;
        };
        experimentalApi?: boolean;
        transport?: {
            type?: "stdio" | "websocket";
            stdio?: StdioTransportSettings;
            websocket?: WebSocketTransportSettings;
        };
        defaultThreadSettings?: CodexThreadDefaults;
        transportFactory?: () => CodexTransport;
        toolHandlers?: Record<string, DynamicToolHandler>;
        toolTimeoutMs?: number;
    };
}

interface ThreadStartResultLike extends CodexThreadStartResult {
    thread?: {
        id?: string;
    };
}

interface TurnStartResultLike extends CodexTurnStartResult {
    turn?: {
        id?: string;
    };
}

type PassThroughStreamContentPart = Extract<
    LanguageModelV3StreamPart,
    { type: "tool-call" | "tool-result" | "file" | "source" | "tool-approval-request" }
>;

function createEmptyUsage(): LanguageModelV3Usage 
{
    return {
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
    };
}

function extractThreadId(result: ThreadStartResultLike): string 
{
    const threadId = result.threadId ?? result.thread?.id;
    if (!threadId) 
    {
        throw new CodexProviderError("thread/start response does not include a thread id.");
    }
    return threadId;
}

function extractTurnId(result: TurnStartResultLike): string 
{
    const turnId = result.turnId ?? result.turn?.id;
    if (!turnId) 
    {
        throw new CodexProviderError("turn/start response does not include a turn id.");
    }
    return turnId;
}

function isPassThroughContentPart(
    part: LanguageModelV3StreamPart,
): part is PassThroughStreamContentPart 
{
    switch (part.type) 
    {
        case "tool-call":
        case "tool-result":
        case "file":
        case "source":
        case "tool-approval-request":
            return true;
        default:
            return false;
    }
}

export class CodexLanguageModel implements LanguageModelV3 
{
    readonly specificationVersion = "v3" as const;
    readonly provider: string;
    readonly modelId: string;
    readonly supportedUrls: Record<string, RegExp[]> = {};

    private readonly settings: CodexLanguageModelSettings;
    private readonly config: CodexModelConfig;

    constructor(
        modelId: string,
        settings: CodexLanguageModelSettings,
        config: CodexModelConfig,
    ) 
    {
        this.modelId = modelId;
        this.settings = settings;
        this.config = config;
        this.provider = config.provider;
    }

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> 
    {
        void this.settings;

        const streamResult = await this.doStream(options);
        const reader = streamResult.stream.getReader();

        const textOrder: string[] = [];
        const textById = new Map<string, string>();
        const passThroughContent: LanguageModelV3Content[] = [];

        let warnings: LanguageModelV3GenerateResult["warnings"] = [];
        let finishReason: LanguageModelV3GenerateResult["finishReason"] = {
            unified: "other",
            raw: undefined,
        };
        let usage: LanguageModelV3Usage = createEmptyUsage();

        while (true) 
        {
            const { value, done } = await reader.read();
            if (done) 
            {
                break;
            }

            if (value.type === "stream-start") 
            {
                warnings = value.warnings;
                continue;
            }

            if (value.type === "text-start") 
            {
                if (!textById.has(value.id)) 
                {
                    textOrder.push(value.id);
                    textById.set(value.id, "");
                }
                continue;
            }

            if (value.type === "text-delta") 
            {
                if (!textById.has(value.id)) 
                {
                    textOrder.push(value.id);
                    textById.set(value.id, value.delta);
                }
                else 
                {
                    textById.set(value.id, `${textById.get(value.id) ?? ""}${value.delta}`);
                }
                continue;
            }

            if (value.type === "finish") 
            {
                finishReason = value.finishReason;
                usage = value.usage;
                continue;
            }

            if (value.type === "error") 
            {
                if (value.error instanceof Error) 
                {
                    throw value.error;
                }

                throw new CodexProviderError("Generation stream emitted an error.", {
                    cause: value.error,
                });
            }

            if (isPassThroughContentPart(value)) 
            {
                passThroughContent.push(value);
            }
        }

        const textContent: LanguageModelV3Content[] = textOrder
            .map((id) => 
            {
                const text = textById.get(id) ?? "";
                if (text.length === 0) 
                {
                    return null;
                }

                return {
                    type: "text" as const,
                    text,
                };
            })
            .filter((part): part is Extract<LanguageModelV3Content, { type: "text" }> => part !== null);

        return {
            content: [...textContent, ...passThroughContent],
            finishReason,
            usage,
            warnings,
            ...(streamResult.request ? { request: streamResult.request } : {}),
        };
    }

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> 
    {
        const transport = this.config.providerSettings.transportFactory
            ? this.config.providerSettings.transportFactory()
            : this.config.providerSettings.transport?.type === "websocket"
                ? new WebSocketTransport(this.config.providerSettings.transport.websocket)
                : new StdioTransport(this.config.providerSettings.transport?.stdio);

        const client = new AppServerClient(transport);
        const mapper = new CodexEventMapper();

        const stream = new ReadableStream<LanguageModelV3StreamPart>({
            start: (controller) => 
            {
                let closed = false;

                const closeWithError = async (error: unknown) => 
                {
                    if (closed) 
                    {
                        return;
                    }

                    controller.enqueue({ type: "error", error });
                    closed = true;

                    try 
                    {
                        controller.close();
                    }
                    finally 
                    {
                        await client.disconnect();
                    }
                };

                const closeSuccessfully = async () => 
                {
                    if (closed) 
                    {
                        return;
                    }

                    closed = true;

                    try 
                    {
                        controller.close();
                    }
                    finally 
                    {
                        await client.disconnect();
                    }
                };

                const abortHandler = () => 
                {
                    void closeWithError(new DOMException("Aborted", "AbortError"));
                };

                if (options.abortSignal) 
                {
                    if (options.abortSignal.aborted) 
                    {
                        abortHandler();
                        return;
                    }
                    options.abortSignal.addEventListener("abort", abortHandler, { once: true });
                }

                void (async () => 
                {
                    try 
                    {
                        await client.connect();

                        const dynamicToolsEnabled =
                            this.config.providerSettings.experimentalApi === true;
                        if (dynamicToolsEnabled) 
                        {
                            const dispatcher = new DynamicToolsDispatcher({
                                ...(this.config.providerSettings.toolHandlers
                                    ? { handlers: this.config.providerSettings.toolHandlers }
                                    : {}),
                                ...(this.config.providerSettings.toolTimeoutMs !== undefined
                                    ? { timeoutMs: this.config.providerSettings.toolTimeoutMs }
                                    : {}),
                            });
                            dispatcher.attach(client);
                        }

                        client.onAnyNotification((method, params) => 
                        {
                            const parts = mapper.map({ method, params });

                            for (const part of parts) 
                            {
                                controller.enqueue(part);

                                if (part.type === "finish") 
                                {
                                    void closeSuccessfully();
                                }
                            }
                        });

                        const initializeParams: CodexInitializeParams = {
                            clientInfo: this.config.providerSettings.clientInfo ?? {
                                name: "codex-ai-sdk-provider",
                                version: "0.1.0",
                            },
                            ...(this.config.providerSettings.experimentalApi !== undefined
                                ? {
                                    capabilities: {
                                        experimentalApi: this.config.providerSettings.experimentalApi,
                                    },
                                }
                                : {}),
                        };

                        await client.request<CodexInitializeResult>("initialize", initializeParams);
                        await client.notification("initialized");

                        const threadStartParams: CodexThreadStartParams = {
                            model: this.config.providerSettings.defaultModel ?? this.modelId,
                            ...(this.config.providerSettings.defaultThreadSettings?.cwd
                                ? { cwd: this.config.providerSettings.defaultThreadSettings.cwd }
                                : {}),
                            ...(this.config.providerSettings.defaultThreadSettings?.approvalMode
                                ? {
                                    approvalMode:
                      this.config.providerSettings.defaultThreadSettings.approvalMode,
                                }
                                : {}),
                            ...(this.config.providerSettings.defaultThreadSettings?.sandboxMode
                                ? {
                                    sandboxMode:
                      this.config.providerSettings.defaultThreadSettings.sandboxMode,
                                }
                                : {}),
                        };

                        const threadStartResult = await client.request<ThreadStartResultLike>(
                            "thread/start",
                            threadStartParams,
                        );
                        const threadId = extractThreadId(threadStartResult);

                        const turnStartResult = await client.request<TurnStartResultLike>("turn/start", {
                            threadId,
                            input: mapPromptToTurnInput(options.prompt),
                        });

                        extractTurnId(turnStartResult);
                    }
                    catch (error) 
                    {
                        await closeWithError(error);
                    }
                })();
            },
            cancel: async () => 
            {
                await client.disconnect();
            },
        });

        return { stream };
    }
}
