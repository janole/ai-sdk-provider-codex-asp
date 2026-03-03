import type {
    LanguageModelV3CallOptions,
    LanguageModelV3StreamPart,
    LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

import { ApprovalsDispatcher } from "../approvals";
import { AppServerClient } from "../client/app-server-client";
import { PersistentTransport } from "../client/transport-persistent";
import { StdioTransport } from "../client/transport-stdio";
import { WebSocketTransport } from "../client/transport-websocket";
import { DynamicToolsDispatcher } from "../dynamic-tools";
import type { CodexModelConfig } from "../model";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-info";
import type { JsonValue } from "../protocol/app-server-protocol/serde_json/JsonValue";
import type { ThreadResumeResponse } from "../protocol/app-server-protocol/v2/ThreadResumeResponse";
import { CodexEventMapper } from "../protocol/event-mapper";
import
{
    extractResumeThreadId,
    extractThreadId,
    extractToolResults,
    extractTurnId,
} from "../protocol/extractors";
import { withProviderMetadata } from "../protocol/provider-metadata";
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
} from "../protocol/types";
import type { CodexCompactionOnResumeContext } from "../provider-settings";
import { EMPTY_USAGE, stripUndefined } from "../utils/object";
import { CodexSessionImpl } from "./codex-session-impl";
import { mapSystemPrompt, PromptFileResolver } from "./prompt-file-resolver";

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

export function createStreamSession(
    config: CodexModelConfig,
    modelId: string,
    options: LanguageModelV3CallOptions,
): Promise<LanguageModelV3StreamResult>
{
    const resumeThreadId = extractResumeThreadId(options.prompt);

    const transport = config.providerSettings.transportFactory
        ? config.providerSettings.transportFactory(stripUndefined({ signal: options.abortSignal, threadId: resumeThreadId }))
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

    const toolLogger = config.providerSettings.debug?.logToolCalls === true
        ? config.providerSettings.debug.toolLogger
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
        emitPlanUpdates: config.providerSettings.emitPlanUpdates,
    }));

    const fileResolver = new PromptFileResolver();
    const interruptTimeoutMs = config.providerSettings.interruptTimeoutMs ?? 10_000;

    let activeThreadId: string | undefined;
    let activeTurnId: string | undefined;
    let session: CodexSessionImpl | undefined;
    let closed = false;

    const close = async (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        error?: unknown,
    ): Promise<void> =>
    {
        if (closed)
        {
            return;
        }

        session?.markInactive();
        if (error !== undefined)
        {
            controller.enqueue({ type: "error", error });
        }
        closed = true;

        try
        {
            controller.close();
        }
        finally
        {
            await Promise.all([fileResolver.cleanup(), client.disconnect()]);
        }
    };

    const interruptTurnIfPossible = async (): Promise<void> =>
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

    const attachApprovals = (): void =>
    {
        const approvalsDispatcher = new ApprovalsDispatcher(stripUndefined({
            onCommandApproval: config.providerSettings.approvals?.onCommandApproval,
            onFileChangeApproval: config.providerSettings.approvals?.onFileChangeApproval,
        }));
        approvalsDispatcher.attach(client);
    };

    const attachNotificationHandler = (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        syncTurnId: boolean,
    ): void =>
    {
        client.onAnyNotification((method, params) =>
        {
            const parts = mapper.map({ method, params });

            if (syncTurnId)
            {
                const mappedTurnId = mapper.getTurnId();
                if (mappedTurnId && mappedTurnId !== activeTurnId)
                {
                    activeTurnId = mappedTurnId;
                    session?.setTurnId(mappedTurnId);
                }
            }

            for (const part of parts)
            {
                controller.enqueue(part);
                if (part.type === "finish")
                {
                    void close(controller);
                }
            }
        });
    };

    const registerCrossCallToolHandler = (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        persistentTransport: PersistentTransport,
        threadId: string,
    ): void =>
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
                usage: EMPTY_USAGE,
            }));

            void close(controller);

            // Return a never-resolving promise to prevent auto-response
            return new Promise<CodexToolCallResult>(() => { });
        });
    };

    const runCrossCallResume = async (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        persistentTransport: PersistentTransport,
        pendingToolCall: NonNullable<ReturnType<PersistentTransport["getPendingToolCall"]>>,
    ): Promise<void> =>
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

        attachNotificationHandler(controller, false);

        // Register cross-call handler again for chained tool calls
        registerCrossCallToolHandler(
            controller,
            persistentTransport,
            pendingToolCall.threadId,
        );

        attachApprovals();

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
    };

    const runFreshThread = async (
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
        persistentTransport: PersistentTransport | null,
    ): Promise<void> =>
    {
        const dynamicToolsEnabled =
            config.providerSettings.experimentalApi === true;
        if (dynamicToolsEnabled)
        {
            const dispatcher = new DynamicToolsDispatcher(stripUndefined({
                tools: config.providerSettings.tools,
                handlers: config.providerSettings.toolHandlers,
                timeoutMs: config.providerSettings.toolTimeoutMs,
                onDebugEvent: toolLogger,
            }));
            dispatcher.attach(client);
        }

        attachApprovals();

        attachNotificationHandler(controller, true);

        // Merge provider-level tools with SDK tools from options
        const providerToolDefs = config.providerSettings.tools;
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
            config.providerSettings.experimentalApi === true || dynamicTools !== undefined;

        const initializeParams: CodexInitializeParams = stripUndefined({
            clientInfo: config.providerSettings.clientInfo ?? {
                name: PACKAGE_NAME,
                version: PACKAGE_VERSION,
            },
            capabilities: needsExperimentalApi ? { experimentalApi: true } : undefined,
        });

        await client.request<CodexInitializeResult>("initialize", initializeParams);
        await client.notification("initialized");

        debugLog?.("inbound", "prompt", options.prompt);

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

            const strictCompaction = config.providerSettings.compaction?.strict === true;
            const shouldCompactOnResume = config.providerSettings.compaction?.shouldCompactOnResume;
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

                    if (strictCompaction)
                    {
                        throw error;
                    }
                }
            }
        }
        else
        {
            const mcpServers = config.providerSettings.mcpServers;
            const threadConfig = mcpServers
                ? { mcp_servers: mcpServers } as CodexThreadStartParams["config"]
                : undefined;

            const threadStartParams: CodexThreadStartParams = stripUndefined({
                model: config.providerSettings.defaultModel ?? modelId,
                dynamicTools,
                developerInstructions,
                config: threadConfig,
                cwd: config.providerSettings.defaultThreadSettings?.cwd,
                approvalPolicy: config.providerSettings.defaultThreadSettings?.approvalPolicy,
                sandbox: config.providerSettings.defaultThreadSettings?.sandbox,
            });
            debugLog?.("outbound", "thread/start", threadStartParams);
            const threadStartResult = await client.request<CodexThreadStartResult & { thread?: { id?: string } }>(
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
            registerCrossCallToolHandler(
                controller,
                persistentTransport,
                threadId,
            );
        }

        const turnInput = await fileResolver.resolve(options.prompt, !!resumeThreadId);
        const turnStartParams: CodexTurnStartParams = stripUndefined({
            threadId,
            input: turnInput,
            cwd: config.providerSettings.defaultTurnSettings?.cwd,
            approvalPolicy: config.providerSettings.defaultTurnSettings?.approvalPolicy,
            sandboxPolicy: config.providerSettings.defaultTurnSettings?.sandboxPolicy,
            model: config.providerSettings.defaultTurnSettings?.model,
            effort: config.providerSettings.defaultTurnSettings?.effort,
            summary: config.providerSettings.defaultTurnSettings?.summary,
            outputSchema: options.responseFormat?.type === "json"
                ? options.responseFormat.schema as JsonValue | undefined
                : undefined,
        });

        debugLog?.("outbound", "turn/start", turnStartParams);

        const turnStartResult = await client.request<CodexTurnStartResult & { turn?: { id?: string } }>("turn/start", turnStartParams);

        activeTurnId = extractTurnId(turnStartResult);

        session = new CodexSessionImpl({
            client,
            threadId: activeThreadId,
            turnId: activeTurnId,
            interruptTimeoutMs,
        });
        config.providerSettings.onSessionCreated?.(session);
    };

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) =>
        {
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

                    await close(controller, new DOMException("Aborted", "AbortError"));
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
                    const persistentTransport = transport instanceof PersistentTransport
                        ? transport
                        : null;
                    const pendingToolCall = persistentTransport?.getPendingToolCall() ?? null;

                    if (pendingToolCall && persistentTransport)
                    {
                        await runCrossCallResume(controller, persistentTransport, pendingToolCall);
                    }
                    else
                    {
                        await runFreshThread(controller, persistentTransport);
                    }
                }
                catch (error)
                {
                    await close(controller, error);
                }
            })();
        },
        cancel: async () =>
        {
            session?.markInactive();

            try
            {
                await interruptTurnIfPossible();
            }
            catch
            {
                // Best-effort only: always disconnect to release resources.
            }
            await Promise.all([fileResolver.cleanup(), client.disconnect()]);
        },
    });

    return Promise.resolve({ stream });
}
