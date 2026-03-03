import type {
    LanguageModelV3CallOptions,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

import { ApprovalsDispatcher } from "./approvals";
import { AppServerClient } from "./client/app-server-client";
import type { CodexTransport } from "./client/transport";
import { PersistentTransport } from "./client/transport-persistent";
import { StdioTransport } from "./client/transport-stdio";
import { WebSocketTransport } from "./client/transport-websocket";
import { DynamicToolsDispatcher } from "./dynamic-tools";
import type { CodexModelConfig } from "./model";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";
import type { JsonValue } from "./protocol/app-server-protocol/serde_json/JsonValue";
import type { ThreadResumeResponse } from "./protocol/app-server-protocol/v2/ThreadResumeResponse";
import { CodexEventMapper } from "./protocol/event-mapper";
import {
    extractResumeThreadId,
    extractThreadId,
    extractToolResults,
    extractTurnId,
} from "./protocol/extractors";
import { withProviderMetadata } from "./protocol/provider-metadata";
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
    CodexTurnInterruptParams,
    CodexTurnInterruptResult,
    CodexTurnStartParams,
    CodexTurnStartResult,
} from "./protocol/types";
import type { CodexCompactionOnResumeContext } from "./provider-settings";
import { CodexSessionImpl } from "./session";
import { EMPTY_USAGE, stripUndefined } from "./utils/object";
import { mapSystemPrompt, PromptFileResolver } from "./utils/prompt-file-resolver";

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

export class StreamSession
{
    private readonly config: CodexModelConfig;
    private readonly modelId: string;
    private readonly options: LanguageModelV3CallOptions;

    private activeThreadId: string | undefined;
    private activeTurnId: string | undefined;
    private session: CodexSessionImpl | undefined;
    private closed = false;

    private readonly transport: CodexTransport;
    private readonly client: AppServerClient;
    private readonly mapper: CodexEventMapper;
    private readonly fileResolver: PromptFileResolver;
    private readonly resumeThreadId: string | undefined;
    private readonly interruptTimeoutMs: number;

    private readonly debugLog: ((direction: "inbound" | "outbound", label: string, data?: unknown) => void) | undefined;
    private readonly toolLogger: ((event: { event: string; data?: unknown }) => void) | undefined;

    constructor(config: CodexModelConfig, modelId: string, options: LanguageModelV3CallOptions)
    {
        this.config = config;
        this.modelId = modelId;
        this.options = options;

        this.resumeThreadId = extractResumeThreadId(options.prompt);

        this.transport = config.providerSettings.transportFactory
            ? config.providerSettings.transportFactory(stripUndefined({ signal: options.abortSignal, threadId: this.resumeThreadId }))
            : config.providerSettings.transport?.type === "websocket"
                ? new WebSocketTransport(config.providerSettings.transport.websocket)
                : new StdioTransport(config.providerSettings.transport?.stdio);

        const packetLogger = config.providerSettings.debug?.logPackets === true
            ? config.providerSettings.debug.logger
            ?? ((packet: { direction: "inbound" | "outbound"; message: unknown }) =>
            {
                if (packet.direction === "inbound")
                {
                    console.debug("[codex packet]", packet.message);
                }
            })
            : undefined;

        this.toolLogger = config.providerSettings.debug?.logToolCalls === true
            ? config.providerSettings.debug.toolLogger
            ?? ((event: { event: string; data?: unknown }) =>
            {
                console.debug("[codex tool]", event.event, event.data);
            })
            : undefined;

        this.debugLog = packetLogger
            ? (direction: "inbound" | "outbound", label: string, data?: unknown) =>
            {
                packetLogger({ direction, message: { debug: label, data } });
            }
            : undefined;

        this.client = new AppServerClient(this.transport, stripUndefined({
            onPacket: packetLogger,
        }));

        this.mapper = new CodexEventMapper(stripUndefined({
            emitPlanUpdates: config.providerSettings.emitPlanUpdates,
        }));

        this.fileResolver = new PromptFileResolver();
        this.interruptTimeoutMs = config.providerSettings.interruptTimeoutMs ?? 10_000;
    }

    execute(): Promise<LanguageModelV3StreamResult>
    {
        const stream = new ReadableStream<LanguageModelV3StreamPart>({
            start: (controller) =>
            {
                const abortHandler = () =>
                {
                    void (async () =>
                    {
                        try
                        {
                            await this.interruptTurnIfPossible();
                        }
                        catch
                        {
                            // Best-effort only: always close/disconnect even if interrupt fails.
                        }

                        await this.close(controller, new DOMException("Aborted", "AbortError"));
                    })();
                };

                if (this.options.abortSignal)
                {
                    if (this.options.abortSignal.aborted)
                    {
                        abortHandler();
                        return;
                    }
                    this.options.abortSignal.addEventListener("abort", abortHandler, { once: true });
                }

                void (async () =>
                {
                    try
                    {
                        await this.client.connect();

                        // ── Tool-result continuation (cross-call) ──
                        const persistentTransport = this.transport instanceof PersistentTransport
                            ? this.transport
                            : null;
                        const pendingToolCall = persistentTransport?.getPendingToolCall() ?? null;

                        if (pendingToolCall && persistentTransport)
                        {
                            await this.runCrossCallResume(controller, persistentTransport, pendingToolCall);
                        }
                        else
                        {
                            await this.runFreshThread(controller, persistentTransport);
                        }
                    }
                    catch (error)
                    {
                        await this.close(controller, error);
                    }
                })();
            },
            cancel: async () =>
            {
                this.session?.markInactive();

                try
                {
                    await this.interruptTurnIfPossible();
                }
                catch
                {
                    // Best-effort only: always disconnect to release resources.
                }
                await Promise.all([this.fileResolver.cleanup(), this.client.disconnect()]);
            },
        });

        return Promise.resolve({ stream });
    }

    // ── Private lifecycle methods ────────────────────────────────────────

    private async close(
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        error?: unknown,
    ): Promise<void>
    {
        if (this.closed)
        {
            return;
        }

        this.session?.markInactive();
        if (error !== undefined)
        {
            controller.enqueue({ type: "error", error });
        }
        this.closed = true;

        try
        {
            controller.close();
        }
        finally
        {
            await Promise.all([this.fileResolver.cleanup(), this.client.disconnect()]);
        }
    }

    private async interruptTurnIfPossible(): Promise<void>
    {
        if (!this.activeThreadId || !this.activeTurnId)
        {
            return;
        }

        const interruptParams: CodexTurnInterruptParams = {
            threadId: this.activeThreadId,
            turnId: this.activeTurnId,
        };
        this.debugLog?.("outbound", "turn/interrupt", interruptParams);
        await this.client.request<CodexTurnInterruptResult>("turn/interrupt", interruptParams, this.interruptTimeoutMs);
    }

    private attachApprovals(): void
    {
        const approvalsDispatcher = new ApprovalsDispatcher(stripUndefined({
            onCommandApproval: this.config.providerSettings.approvals?.onCommandApproval,
            onFileChangeApproval: this.config.providerSettings.approvals?.onFileChangeApproval,
        }));
        approvalsDispatcher.attach(this.client);
    }

    private attachNotificationHandler(
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        syncTurnId: boolean,
    ): void
    {
        this.client.onAnyNotification((method, params) =>
        {
            const parts = this.mapper.map({ method, params });

            if (syncTurnId)
            {
                const mappedTurnId = this.mapper.getTurnId();
                if (mappedTurnId && mappedTurnId !== this.activeTurnId)
                {
                    this.activeTurnId = mappedTurnId;
                    this.session?.setTurnId(mappedTurnId);
                }
            }

            for (const part of parts)
            {
                controller.enqueue(part);
                if (part.type === "finish")
                {
                    void this.close(controller);
                }
            }
        });
    }

    // ── Cross-call resume flow ───────────────────────────────────────────

    private async runCrossCallResume(
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        persistentTransport: PersistentTransport,
        pendingToolCall: NonNullable<ReturnType<PersistentTransport["getPendingToolCall"]>>,
    ): Promise<void>
    {
        this.toolLogger?.({
            event: "cross-call-resume",
            data: {
                threadId: pendingToolCall.threadId,
                callId: pendingToolCall.callId,
                toolName: pendingToolCall.toolName,
            },
        });
        const toolResult = extractToolResults(this.options.prompt, pendingToolCall.callId);
        this.toolLogger?.({
            event: "cross-call-result-extracted",
            data: {
                callId: pendingToolCall.callId,
                found: !!toolResult,
                success: toolResult?.success,
                contentItemsCount: toolResult?.contentItems.length ?? 0,
            },
        });
        this.mapper.setThreadId(pendingToolCall.threadId);

        this.attachNotificationHandler(controller, false);

        // Register cross-call handler again for chained tool calls
        this.registerCrossCallToolHandler(
            controller, persistentTransport,
            pendingToolCall.threadId,
        );

        this.attachApprovals();

        const result = toolResult ?? {
            success: false,
            contentItems: [{
                type: "inputText",
                text: `Missing tool result for pending callId "${pendingToolCall.callId}".`,
            }],
        };

        await persistentTransport.respondToToolCall(result);

        this.toolLogger?.({
            event: "cross-call-result-sent",
            data: {
                callId: pendingToolCall.callId,
                found: !!toolResult,
                success: result.success,
                contentItemsCount: result.contentItems.length ?? 0,
            },
        });
    }

    // ── Normal (fresh thread) flow ───────────────────────────────────────

    private async runFreshThread(
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        persistentTransport: PersistentTransport | null,
    ): Promise<void>
    {
        const dynamicToolsEnabled =
            this.config.providerSettings.experimentalApi === true;
        if (dynamicToolsEnabled)
        {
            const dispatcher = new DynamicToolsDispatcher(stripUndefined({
                tools: this.config.providerSettings.tools,
                handlers: this.config.providerSettings.toolHandlers,
                timeoutMs: this.config.providerSettings.toolTimeoutMs,
                onDebugEvent: this.toolLogger,
            }));
            dispatcher.attach(this.client);
        }

        this.attachApprovals();

        this.attachNotificationHandler(controller, true);

        // Merge provider-level tools with SDK tools from options
        const providerToolDefs = this.config.providerSettings.tools;
        const providerDynamicTools = providerToolDefs
            ? Object.entries(providerToolDefs).map(([name, def]) => ({
                name,
                description: def.description,
                inputSchema: def.inputSchema,
            }))
            : [];

        const sdkDynamicTools = this.options.tools
            ? sdkToolsToCodexDynamicTools(this.options.tools)
            : [];

        const allDynamicTools = [...providerDynamicTools, ...sdkDynamicTools];
        const dynamicTools = allDynamicTools.length > 0 ? allDynamicTools : undefined;
        this.toolLogger?.({
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

        await this.client.request<CodexInitializeResult>("initialize", initializeParams);
        await this.client.notification("initialized");

        this.debugLog?.("inbound", "prompt", this.options.prompt);

        this.debugLog?.("inbound", "extractResumeThreadId", { resumeThreadId: this.resumeThreadId });

        const developerInstructions = mapSystemPrompt(this.options.prompt);

        let threadId: string;

        if (this.resumeThreadId)
        {
            const resumeParams: CodexThreadResumeParams = stripUndefined({
                threadId: this.resumeThreadId,
                persistExtendedHistory: false,
                developerInstructions,
            });
            this.debugLog?.("outbound", "thread/resume", resumeParams);
            const resumeResult = await this.client.request<ThreadResumeResponse>(
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
                    resumeThreadId: this.resumeThreadId,
                    resumeResult,
                    prompt: this.options.prompt,
                };

                try
                {
                    shouldCompact = await shouldCompactOnResume(compactionContext);
                }
                catch (error)
                {
                    this.debugLog?.("inbound", "thread/compact/start:decision-error", {
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
                this.debugLog?.("outbound", "thread/compact/start", compactParams);
                if (strictCompaction)
                {
                    await this.client.request<CodexThreadCompactStartResult>(
                        "thread/compact/start",
                        compactParams,
                    );
                }
                else
                {
                    try
                    {
                        await this.client.request<CodexThreadCompactStartResult>(
                            "thread/compact/start",
                            compactParams,
                        );
                    }
                    catch (error)
                    {
                        this.debugLog?.("inbound", "thread/compact/start:error", {
                            message: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            }
        }
        else
        {
            const mcpServers = this.config.providerSettings.mcpServers;
            const config = mcpServers
                ? { mcp_servers: mcpServers } as CodexThreadStartParams["config"]
                : undefined;

            const threadStartParams: CodexThreadStartParams = stripUndefined({
                model: this.config.providerSettings.defaultModel ?? this.modelId,
                dynamicTools,
                developerInstructions,
                config,
                cwd: this.config.providerSettings.defaultThreadSettings?.cwd,
                approvalPolicy: this.config.providerSettings.defaultThreadSettings?.approvalPolicy,
                sandbox: this.config.providerSettings.defaultThreadSettings?.sandbox,
            });
            this.debugLog?.("outbound", "thread/start", threadStartParams);
            const threadStartResult = await this.client.request<CodexThreadStartResult & { thread?: { id?: string } }>(
                "thread/start",
                threadStartParams,
            );
            threadId = extractThreadId(threadStartResult);
        }

        this.activeThreadId = threadId;
        this.mapper.setThreadId(threadId);

        // Register cross-call tool handler for SDK tools
        if (hasSdkTools && persistentTransport)
        {
            this.registerCrossCallToolHandler(
                controller, persistentTransport,
                threadId,
            );
        }

        const turnInput = await this.fileResolver.resolve(this.options.prompt, !!this.resumeThreadId);
        const turnStartParams: CodexTurnStartParams = stripUndefined({
            threadId,
            input: turnInput,
            cwd: this.config.providerSettings.defaultTurnSettings?.cwd,
            approvalPolicy: this.config.providerSettings.defaultTurnSettings?.approvalPolicy,
            sandboxPolicy: this.config.providerSettings.defaultTurnSettings?.sandboxPolicy,
            model: this.config.providerSettings.defaultTurnSettings?.model,
            effort: this.config.providerSettings.defaultTurnSettings?.effort,
            summary: this.config.providerSettings.defaultTurnSettings?.summary,
            outputSchema: this.options.responseFormat?.type === "json"
                ? this.options.responseFormat.schema as JsonValue | undefined
                : undefined,
        });

        this.debugLog?.("outbound", "turn/start", turnStartParams);

        const turnStartResult = await this.client.request<CodexTurnStartResult & { turn?: { id?: string } }>("turn/start", turnStartParams);

        this.activeTurnId = extractTurnId(turnStartResult);

        this.session = new CodexSessionImpl({
            client: this.client,
            threadId: this.activeThreadId,
            turnId: this.activeTurnId,
            interruptTimeoutMs: this.interruptTimeoutMs,
        });
        this.config.providerSettings.onSessionCreated?.(this.session);
    }

    // ── Cross-call tool handler ──────────────────────────────────────────

    private registerCrossCallToolHandler(
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        persistentTransport: PersistentTransport,
        threadId: string,
    ): void
    {
        this.client.onToolCallRequest((params: CodexToolCallRequestParams, request) =>
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
                usage: EMPTY_USAGE,
            }));

            void this.close(controller);

            // Return a never-resolving promise to prevent auto-response
            return new Promise<CodexToolCallResult>(() => { });
        });
    }
}
