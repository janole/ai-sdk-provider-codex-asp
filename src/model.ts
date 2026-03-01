import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3Content,
    LanguageModelV3GenerateResult,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";

import { ApprovalsDispatcher } from "./approvals";
import { AppServerClient } from "./client/app-server-client";
import { PersistentTransport } from "./client/transport-persistent";
import { StdioTransport } from "./client/transport-stdio";
import { WebSocketTransport } from "./client/transport-websocket";
import { DynamicToolsDispatcher } from "./dynamic-tools";
import { CodexProviderError } from "./errors";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";
import type { ThreadResumeResponse } from "./protocol/app-server-protocol/v2/ThreadResumeResponse";
import { CodexEventMapper } from "./protocol/event-mapper";
import { mapPromptToTurnInput, mapSystemPrompt } from "./protocol/prompt-mapper";
import { CODEX_PROVIDER_ID, withProviderMetadata } from "./protocol/provider-metadata";
import type {
    CodexInitializeParams,
    CodexInitializeResult,
    CodexThreadCompactStartParams,
    CodexThreadCompactStartResult,
    CodexThreadResumeParams,
    CodexThreadStartParams,
    CodexThreadStartResult,
    CodexToolCallRequestParams,
    CodexToolCallResult,
    CodexToolResultContentItem,
    CodexTurnInterruptParams,
    CodexTurnInterruptResult,
    CodexTurnStartParams,
    CodexTurnStartResult,
} from "./protocol/types";
import type { CodexCompactionOnResumeContext, CodexProviderSettings } from "./provider-settings";
import { stripUndefined } from "./utils/object";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CodexLanguageModelSettings
{
    // intentionally empty — settings will be added as the API evolves
}

export type { CodexThreadDefaults, CodexTurnDefaults } from "./provider-settings";

export interface CodexModelConfig
{
    provider: string;
    providerSettings: Readonly<CodexProviderSettings>;
}

interface ThreadStartResultLike extends CodexThreadStartResult
{
    thread?: {
        id?: string;
    };
}

interface TurnStartResultLike extends CodexTurnStartResult
{
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

function extractThreadIdFromProviderOptions(
    providerOptions: Record<string, unknown> | undefined,
): string | undefined
{
    const meta = providerOptions?.[CODEX_PROVIDER_ID];
    if (meta && typeof meta === "object" && "threadId" in meta && typeof (meta as Record<string, unknown>)["threadId"] === "string")
    {
        return (meta as Record<string, unknown>)["threadId"] as string;
    }
    return undefined;
}

function extractResumeThreadId(prompt: LanguageModelV3CallOptions["prompt"]): string | undefined
{
    for (let i = prompt.length - 1; i >= 0; i--)
    {
        const message = prompt[i];
        if (message?.role === "assistant")
        {
            // Check message-level providerOptions
            const messageThreadId = extractThreadIdFromProviderOptions(
                message.providerOptions as Record<string, unknown> | undefined,
            );
            if (messageThreadId)
            {
                return messageThreadId;
            }

            // Check content-part-level providerOptions
            if (Array.isArray(message.content))
            {
                for (const part of message.content)
                {
                    const partThreadId = extractThreadIdFromProviderOptions(
                        (part as { providerOptions?: Record<string, unknown> }).providerOptions,
                    );
                    if (partThreadId)
                    {
                        return partThreadId;
                    }
                }
            }
        }
    }
    return undefined;
}

function extractToolResults(
    prompt: LanguageModelV3CallOptions["prompt"],
    callId?: string,
): CodexToolCallResult | undefined
{
    for (let i = prompt.length - 1; i >= 0; i--)
    {
        const message = prompt[i];
        if (message?.role === "tool")
        {
            const contentItems: CodexToolResultContentItem[] = [];
            let success = true;

            for (const part of message.content)
            {
                if (part.type === "tool-result")
                {
                    if (callId && part.toolCallId !== callId)
                    {
                        continue;
                    }

                    if (part.output.type === "text")
                    {
                        contentItems.push({ type: "inputText", text: part.output.value });
                    }
                    else if (part.output.type === "json")
                    {
                        contentItems.push({ type: "inputText", text: JSON.stringify(part.output.value) });
                    }
                    else if (part.output.type === "execution-denied")
                    {
                        success = false;
                        contentItems.push({
                            type: "inputText",
                            text: part.output.reason ?? "Tool execution was denied.",
                        });
                    }
                }
            }

            if (contentItems.length > 0)
            {
                return { success, contentItems };
            }

            if (callId)
            {
                // A matching callId was requested, so don't consume unrelated
                // tool results from older prompt entries.
                return undefined;
            }
        }
    }
    return undefined;
}

function sdkToolsToCodexDynamicTools(
    tools: NonNullable<LanguageModelV3CallOptions["tools"]>,
): { name: string; description?: string; inputSchema: Record<string, unknown> }[]
{
    return tools
        .filter((t): t is Extract<typeof t, { type: "function" }> => t.type === "function")
        .map((t) => stripUndefined({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
        }));
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
        let providerMetadata: LanguageModelV3GenerateResult["providerMetadata"];

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
                providerMetadata = value.providerMetadata;
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

        return stripUndefined({
            content: [...textContent, ...passThroughContent],
            finishReason,
            usage,
            warnings,
            providerMetadata,
            request: streamResult.request,
        });
    }

    private registerCrossCallToolHandler(
        client: AppServerClient,
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        persistentTransport: PersistentTransport,
        threadId: string,
        closeSuccessfully: () => Promise<void>,
    ): void
    {
        client.onToolCallRequest((params: CodexToolCallRequestParams, request) =>
        {
            const toolName = params.tool ?? params.toolName ?? "unknown";
            const callId = params.callId ?? `call_${Date.now()}`;
            const args = params.arguments ?? params.input ?? {};

            const withMeta = <T extends LanguageModelV3StreamPart>(part: T): T => withProviderMetadata(part, threadId);

            // Park the tool call on the worker for cross-call resumption.
            // Return a never-resolving promise so AppServerClient does NOT
            // auto-send a JSON-RPC response — we respond manually on the
            // next doStream() via persistentTransport.respondToToolCall().
            persistentTransport.parkToolCall({
                requestId: request.id,
                callId,
                toolName,
                args,
                threadId,
            });

            controller.enqueue(withMeta({
                type: "tool-call",
                toolCallId: callId,
                toolName,
                input: typeof args === "string" ? args : JSON.stringify(args),
            }));

            controller.enqueue(withMeta({
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: createEmptyUsage(),
            }));

            void closeSuccessfully();

            // Return a never-resolving promise to prevent auto-response
            return new Promise<CodexToolCallResult>(() => { });
        });
    }

    doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult>
    {
        const transport = this.config.providerSettings.transportFactory
            ? this.config.providerSettings.transportFactory(options.abortSignal)
            : this.config.providerSettings.transport?.type === "websocket"
                ? new WebSocketTransport(this.config.providerSettings.transport.websocket)
                : new StdioTransport(this.config.providerSettings.transport?.stdio);

        const packetLogger = this.config.providerSettings.debug?.logPackets === true
            ? this.config.providerSettings.debug.logger
            ?? ((packet: { direction: "inbound" | "outbound"; message: unknown }) =>
            {
                if (packet.direction === "inbound")
                {
                    console.debug("[codex packet]", packet.message);
                }
            })
            : undefined;

        const toolLogger = this.config.providerSettings.debug?.logToolCalls === true
            ? this.config.providerSettings.debug.toolLogger
            ?? ((event: { event: string; data?: unknown }) =>
            {
                console.debug("[codex tool]", event.event, event.data);
            })
            : undefined;

        const debugLog = packetLogger
            ? (direction: "inbound" | "outbound", label: string, data?: unknown) =>
            {
                packetLogger({ direction, message: { debug: label, data } });
            }
            : undefined;

        const client = new AppServerClient(transport, stripUndefined({
            onPacket: packetLogger,
        }));

        const mapper = new CodexEventMapper(stripUndefined({
            emitPlanUpdates: this.config.providerSettings.emitPlanUpdates,
        }));
        let activeThreadId: string | undefined;
        let activeTurnId: string | undefined;
        const interruptTimeoutMs = this.config.providerSettings.interruptTimeoutMs ?? 10_000;

        const interruptTurnIfPossible = async () =>
        {
            if (!activeThreadId || !activeTurnId)
            {
                return;
            }

            const interruptParams: CodexTurnInterruptParams = {
                threadId: activeThreadId,
                turnId: activeTurnId,
            };
            debugLog?.("outbound", "turn/interrupt", interruptParams);
            await client.request<CodexTurnInterruptResult>("turn/interrupt", interruptParams, interruptTimeoutMs);
        };

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
                    void (async () =>
                    {
                        try
                        {
                            await interruptTurnIfPossible();
                        }
                        catch
                        {
                            // Best-effort only: always close/disconnect even if interrupt fails.
                        }

                        await closeWithError(new DOMException("Aborted", "AbortError"));
                    })();
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

                        // ── Tool-result continuation (cross-call) ──
                        // If the transport has a pending tool call from a previous
                        // doStream(), respond with the tool results and let Codex continue.
                        const persistentTransport = transport instanceof PersistentTransport
                            ? transport
                            : null;
                        const pendingToolCall = persistentTransport?.getPendingToolCall() ?? null;

                        if (pendingToolCall && persistentTransport)
                        {
                            toolLogger?.({
                                event: "cross-call-resume",
                                data: {
                                    threadId: pendingToolCall.threadId,
                                    callId: pendingToolCall.callId,
                                    toolName: pendingToolCall.toolName,
                                },
                            });
                            const toolResult = extractToolResults(options.prompt, pendingToolCall.callId);
                            toolLogger?.({
                                event: "cross-call-result-extracted",
                                data: {
                                    callId: pendingToolCall.callId,
                                    found: !!toolResult,
                                    success: toolResult?.success,
                                    contentItemsCount: toolResult?.contentItems.length ?? 0,
                                },
                            });
                            mapper.setThreadId(pendingToolCall.threadId);

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

                            // Register cross-call handler again for chained tool calls
                            this.registerCrossCallToolHandler(
                                client, controller, persistentTransport,
                                pendingToolCall.threadId, closeSuccessfully,
                            );

                            const approvalsDispatcher = new ApprovalsDispatcher(stripUndefined({
                                onCommandApproval: this.config.providerSettings.approvals?.onCommandApproval,
                                onFileChangeApproval: this.config.providerSettings.approvals?.onFileChangeApproval,
                            }));
                            approvalsDispatcher.attach(client);

                            const result = toolResult ?? {
                                success: false,
                                contentItems: [{
                                    type: "inputText",
                                    text: `Missing tool result for pending callId "${pendingToolCall.callId}".`,
                                }],
                            };

                            await persistentTransport.respondToToolCall(result);

                            toolLogger?.({
                                event: "cross-call-result-sent",
                                data: {
                                    callId: pendingToolCall.callId,
                                    found: !!toolResult,
                                    success: result.success,
                                    contentItemsCount: result.contentItems.length ?? 0,
                                },
                            });

                            return;
                        }

                        // ── Normal flow ──
                        const dynamicToolsEnabled =
                            this.config.providerSettings.experimentalApi === true;
                        if (dynamicToolsEnabled)
                        {
                            const dispatcher = new DynamicToolsDispatcher(stripUndefined({
                                tools: this.config.providerSettings.tools,
                                handlers: this.config.providerSettings.toolHandlers,
                                timeoutMs: this.config.providerSettings.toolTimeoutMs,
                                onDebugEvent: toolLogger,
                            }));
                            dispatcher.attach(client);
                        }

                        const approvalsDispatcher = new ApprovalsDispatcher(stripUndefined({
                            onCommandApproval: this.config.providerSettings.approvals?.onCommandApproval,
                            onFileChangeApproval: this.config.providerSettings.approvals?.onFileChangeApproval,
                        }));
                        approvalsDispatcher.attach(client);

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

                        // Merge provider-level tools with SDK tools from options
                        const providerToolDefs = this.config.providerSettings.tools;
                        const providerDynamicTools = providerToolDefs
                            ? Object.entries(providerToolDefs).map(([name, def]) => ({
                                name,
                                description: def.description,
                                inputSchema: def.inputSchema,
                            }))
                            : [];

                        const sdkDynamicTools = options.tools
                            ? sdkToolsToCodexDynamicTools(options.tools)
                            : [];

                        const allDynamicTools = [...providerDynamicTools, ...sdkDynamicTools];
                        const dynamicTools = allDynamicTools.length > 0 ? allDynamicTools : undefined;
                        toolLogger?.({
                            event: "dynamic-tools-advertised",
                            data: {
                                providerTools: providerDynamicTools.map((t) => t.name),
                                sdkTools: sdkDynamicTools.map((t) => t.name),
                                total: allDynamicTools.length,
                            },
                        });

                        const hasSdkTools = sdkDynamicTools.length > 0;

                        // Auto-enable experimentalApi when any dynamic tools are present
                        const needsExperimentalApi =
                            this.config.providerSettings.experimentalApi === true || dynamicTools !== undefined;

                        const initializeParams: CodexInitializeParams = stripUndefined({
                            clientInfo: this.config.providerSettings.clientInfo ?? {
                                name: PACKAGE_NAME,
                                version: PACKAGE_VERSION,
                            },
                            capabilities: needsExperimentalApi ? { experimentalApi: true } : undefined,
                        });

                        await client.request<CodexInitializeResult>("initialize", initializeParams);
                        await client.notification("initialized");

                        debugLog?.("inbound", "prompt", options.prompt);

                        const resumeThreadId = extractResumeThreadId(options.prompt);
                        debugLog?.("inbound", "extractResumeThreadId", { resumeThreadId });

                        const developerInstructions = mapSystemPrompt(options.prompt);

                        let threadId: string;

                        if (resumeThreadId)
                        {
                            const resumeParams: CodexThreadResumeParams = stripUndefined({
                                threadId: resumeThreadId,
                                persistExtendedHistory: false,
                                developerInstructions,
                            });
                            debugLog?.("outbound", "thread/resume", resumeParams);
                            const resumeResult = await client.request<ThreadResumeResponse>(
                                "thread/resume",
                                resumeParams,
                            );
                            threadId = resumeResult.thread.id;

                            const strictCompaction = this.config.providerSettings.compaction?.strict === true;
                            const shouldCompactOnResume = this.config.providerSettings.compaction?.shouldCompactOnResume;
                            let shouldCompact = false;

                            if (typeof shouldCompactOnResume === "boolean")
                            {
                                shouldCompact = shouldCompactOnResume;
                            }
                            else if (typeof shouldCompactOnResume === "function")
                            {
                                const compactionContext: CodexCompactionOnResumeContext = {
                                    threadId,
                                    resumeThreadId,
                                    resumeResult,
                                    prompt: options.prompt,
                                };

                                try
                                {
                                    shouldCompact = await shouldCompactOnResume(compactionContext);
                                }
                                catch (error)
                                {
                                    debugLog?.("inbound", "thread/compact/start:decision-error", {
                                        message: error instanceof Error ? error.message : String(error),
                                    });

                                    if (strictCompaction)
                                    {
                                        throw error;
                                    }
                                }
                            }

                            if (shouldCompact)
                            {
                                const compactParams: CodexThreadCompactStartParams = { threadId };
                                debugLog?.("outbound", "thread/compact/start", compactParams);
                                if (strictCompaction)
                                {
                                    await client.request<CodexThreadCompactStartResult>(
                                        "thread/compact/start",
                                        compactParams,
                                    );
                                }
                                else
                                {
                                    try
                                    {
                                        await client.request<CodexThreadCompactStartResult>(
                                            "thread/compact/start",
                                            compactParams,
                                        );
                                    }
                                    catch (error)
                                    {
                                        debugLog?.("inbound", "thread/compact/start:error", {
                                            message: error instanceof Error ? error.message : String(error),
                                        });
                                    }
                                }
                            }
                        }
                        else
                        {
                            const threadStartParams: CodexThreadStartParams = stripUndefined({
                                model: this.config.providerSettings.defaultModel ?? this.modelId,
                                dynamicTools,
                                developerInstructions,
                                cwd: this.config.providerSettings.defaultThreadSettings?.cwd,
                                approvalPolicy: this.config.providerSettings.defaultThreadSettings?.approvalPolicy,
                                sandbox: this.config.providerSettings.defaultThreadSettings?.sandbox,
                            });
                            debugLog?.("outbound", "thread/start", threadStartParams);
                            const threadStartResult = await client.request<ThreadStartResultLike>(
                                "thread/start",
                                threadStartParams,
                            );
                            threadId = extractThreadId(threadStartResult);
                        }

                        activeThreadId = threadId;
                        mapper.setThreadId(threadId);

                        // Register cross-call tool handler for SDK tools
                        if (hasSdkTools && persistentTransport)
                        {
                            this.registerCrossCallToolHandler(
                                client, controller, persistentTransport,
                                threadId, closeSuccessfully,
                            );
                        }

                        const turnInput = mapPromptToTurnInput(options.prompt, !!resumeThreadId);
                        const turnStartParams: CodexTurnStartParams = stripUndefined({
                            threadId,
                            input: turnInput,
                            cwd: this.config.providerSettings.defaultTurnSettings?.cwd,
                            approvalPolicy: this.config.providerSettings.defaultTurnSettings?.approvalPolicy,
                            sandboxPolicy: this.config.providerSettings.defaultTurnSettings?.sandboxPolicy,
                            model: this.config.providerSettings.defaultTurnSettings?.model,
                            effort: this.config.providerSettings.defaultTurnSettings?.effort,
                            summary: this.config.providerSettings.defaultTurnSettings?.summary,
                        });

                        debugLog?.("outbound", "turn/start", turnStartParams);

                        const turnStartResult = await client.request<TurnStartResultLike>("turn/start", turnStartParams);

                        activeTurnId = extractTurnId(turnStartResult);
                    }
                    catch (error)
                    {
                        await closeWithError(error);
                    }
                })();
            },
            cancel: async () => 
            {
                try
                {
                    await interruptTurnIfPossible();
                }
                catch
                {
                    // Best-effort only: always disconnect to release resources.
                }
                await client.disconnect();
            },
        });

        return Promise.resolve({ stream });
    }
}
