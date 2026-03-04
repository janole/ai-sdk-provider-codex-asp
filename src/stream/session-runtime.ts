import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

import { AppServerClient } from "../client/app-server-client";
import { StdioTransport } from "../client/transport-stdio";
import { WebSocketTransport } from "../client/transport-websocket";
import type { CodexModelConfig } from "../model";
import { CodexEventMapper } from "../protocol/event-mapper";
import { extractResumeThreadId } from "../protocol/extractors";
import { stripUndefined } from "../utils/object";
import { PromptFileResolver } from "./prompt-file-resolver";

export type StreamDebugLog =
    | ((direction: "inbound" | "outbound", label: string, data?: unknown) => void)
    | undefined;

export type StreamToolLog =
    | ((event: { event: string; data?: unknown }) => void)
    | undefined;

export interface StreamSessionRuntime
{
    resumeThreadId: string | undefined;
    transport: ReturnType<typeof createTransport>;
    client: AppServerClient;
    mapper: CodexEventMapper;
    fileResolver: PromptFileResolver;
    interruptTimeoutMs: number;
    debugLog: StreamDebugLog;
    toolLogger: StreamToolLog;
}

function createTransport(
    config: CodexModelConfig,
    options: LanguageModelV3CallOptions,
    resumeThreadId: string | undefined,
): StdioTransport | WebSocketTransport | ReturnType<NonNullable<CodexModelConfig["providerSettings"]["transportFactory"]>>
{
    return config.providerSettings.transportFactory
        ? config.providerSettings.transportFactory(stripUndefined({ signal: options.abortSignal, threadId: resumeThreadId }))
        : config.providerSettings.transport?.type === "websocket"
            ? new WebSocketTransport(config.providerSettings.transport.websocket)
            : new StdioTransport(config.providerSettings.transport?.stdio);
}

export function createStreamSessionRuntime(
    config: CodexModelConfig,
    options: LanguageModelV3CallOptions,
): StreamSessionRuntime
{
    const resumeThreadId = extractResumeThreadId(options.prompt);
    const transport = createTransport(config, options, resumeThreadId);

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

    const toolLogger: StreamToolLog = config.providerSettings.debug?.logToolCalls === true
        ? config.providerSettings.debug.toolLogger
        ?? ((event: { event: string; data?: unknown }) =>
        {
            console.debug("[codex tool]", event.event, event.data);
        })
        : undefined;

    const debugLog: StreamDebugLog = packetLogger
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

    return {
        resumeThreadId,
        transport,
        client,
        mapper,
        fileResolver: new PromptFileResolver(),
        interruptTimeoutMs: config.providerSettings.interruptTimeoutMs ?? 10_000,
        debugLog,
        toolLogger,
    };
}
