import { NoSuchModelError, type ProviderV3 } from "@ai-sdk/provider";

import { AppServerClient } from "./client/app-server-client";
import {
    acquirePersistentPool,
    type PersistentPoolHandle,
} from "./client/persistent-pool-registry";
import { PersistentTransport } from "./client/transport-persistent";
import { StdioTransport } from "./client/transport-stdio";
import { WebSocketTransport } from "./client/transport-websocket";
import { CodexLanguageModel, type CodexLanguageModelSettings } from "./model";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-info";
import type { Model } from "./protocol/app-server-protocol/v2/Model";
import type { ModelListParams } from "./protocol/app-server-protocol/v2/ModelListParams";
import type { ModelListResponse } from "./protocol/app-server-protocol/v2/ModelListResponse";
import { CODEX_PROVIDER_ID } from "./protocol/provider-metadata";
import type { CodexInitializeParams, CodexInitializeResult } from "./protocol/types";
import type { CodexProviderSettings } from "./provider-settings";
import { stripUndefined } from "./utils/object";
export type { Model as CodexModel } from "./protocol/app-server-protocol/v2/Model";
export type { CodexProviderSettings, McpServerConfig } from "./provider-settings";

export interface CodexProvider extends ProviderV3 {
    (
        modelId: string,
        settings?: CodexLanguageModelSettings,
    ): CodexLanguageModel;
    chat(modelId: string, settings?: CodexLanguageModelSettings): CodexLanguageModel;
    listModels(params?: ModelListParams): Promise<Model[]>;
    readonly settings: Readonly<CodexProviderSettings>;
    shutdown(): Promise<void>;
}

function createNoSuchModelError(
    modelId: string,
    modelType: "embeddingModel" | "imageModel",
): NoSuchModelError 
{
    return new NoSuchModelError({ modelId, modelType });
}

export function createCodexAppServer(
    settings: CodexProviderSettings = {},
): CodexProvider 
{
    let persistentPoolHandle: PersistentPoolHandle | null = null;

    const baseTransportFactory = settings.transportFactory;

    if (settings.persistent)
    {
        const scope = settings.persistent.scope ?? "provider";
        const poolSize = settings.persistent.poolSize ?? 1;
        const idleTimeoutMs = settings.persistent.idleTimeoutMs ?? 300_000;
        const poolTransportFactory = baseTransportFactory
            ?? (settings.transport?.type === "websocket"
                ? () => new WebSocketTransport(settings.transport?.websocket)
                : () => new StdioTransport(settings.transport?.stdio));

        persistentPoolHandle = acquirePersistentPool({
            scope,
            ...stripUndefined({ key: settings.persistent.key }),
            poolSize,
            idleTimeoutMs,
            transportFactory: poolTransportFactory,
        });
    }

    const persistentPool = persistentPoolHandle?.pool ?? null;
    const effectiveTransportFactory = persistentPool
        ? (signal?: AbortSignal) => new PersistentTransport(stripUndefined({ pool: persistentPool, signal }))
        : baseTransportFactory;

    const resolvedSettings: Readonly<CodexProviderSettings> = Object.freeze(stripUndefined({
        defaultModel: settings.defaultModel,
        experimentalApi: settings.experimentalApi,
        clientInfo: settings.clientInfo
            ? stripUndefined({
                name: settings.clientInfo.name,
                version: settings.clientInfo.version,
                title: settings.clientInfo.title,
            })
            : undefined,
        transport: settings.transport
            ? stripUndefined({
                type: settings.transport.type,
                stdio: settings.transport.stdio
                    ? { ...settings.transport.stdio }
                    : undefined,
                websocket: settings.transport.websocket
                    ? { ...settings.transport.websocket }
                    : undefined,
            })
            : undefined,
        defaultThreadSettings: settings.defaultThreadSettings
            ? { ...settings.defaultThreadSettings }
            : undefined,
        defaultTurnSettings: settings.defaultTurnSettings
            ? { ...settings.defaultTurnSettings }
            : undefined,
        compaction: settings.compaction
            ? { ...settings.compaction }
            : undefined,
        transportFactory: effectiveTransportFactory,
        mcpServers: settings.mcpServers ? { ...settings.mcpServers } : undefined,
        tools: settings.tools ? { ...settings.tools } : undefined,
        toolHandlers: settings.toolHandlers ? { ...settings.toolHandlers } : undefined,
        toolTimeoutMs: settings.toolTimeoutMs,
        interruptTimeoutMs: settings.interruptTimeoutMs,
        approvals: settings.approvals ? { ...settings.approvals } : undefined,
        debug: settings.debug ? { ...settings.debug } : undefined,
        emitPlanUpdates: settings.emitPlanUpdates,
    }));

    const createLanguageModel = (
        modelId: string,
        modelSettings: CodexLanguageModelSettings = {},
    ): CodexLanguageModel =>
        new CodexLanguageModel(modelId, modelSettings, {
            provider: CODEX_PROVIDER_ID,
            providerSettings: resolvedSettings,
        });

    const providerFn = (
        (modelId: string, modelSettings: CodexLanguageModelSettings = {}) =>
            createLanguageModel(modelId, modelSettings)
    );

    const provider = Object.assign(providerFn, {
        specificationVersion: "v3" as const,
        settings: resolvedSettings,
        languageModel(modelId: string): CodexLanguageModel
        {
            return createLanguageModel(modelId);
        },
        chat(
            modelId: string,
            modelSettings: CodexLanguageModelSettings = {},
        ): CodexLanguageModel
        {
            return createLanguageModel(modelId, modelSettings);
        },
        embeddingModel(modelId: string)
        {
            throw createNoSuchModelError(modelId, "embeddingModel");
        },
        imageModel(modelId: string)
        {
            throw createNoSuchModelError(modelId, "imageModel");
        },
        async listModels(params?: ModelListParams): Promise<Model[]>
        {
            const transport = effectiveTransportFactory
                ? effectiveTransportFactory()
                : resolvedSettings.transport?.type === "websocket"
                    ? new WebSocketTransport(resolvedSettings.transport.websocket)
                    : new StdioTransport(resolvedSettings.transport?.stdio);

            const client = new AppServerClient(transport);

            try
            {
                await client.connect();

                const initializeParams: CodexInitializeParams = stripUndefined({
                    clientInfo: resolvedSettings.clientInfo ?? {
                        name: PACKAGE_NAME,
                        version: PACKAGE_VERSION,
                    },
                });

                await client.request<CodexInitializeResult>("initialize", initializeParams);
                await client.notification("initialized");

                const models: Model[] = [];
                let cursor: string | undefined;

                do
                {
                    const response = await client.request<ModelListResponse>(
                        "model/list",
                        stripUndefined({ ...params, cursor }),
                    );
                    models.push(...response.data);
                    cursor = response.nextCursor ?? undefined;
                }
                while (cursor);

                return models;
            }
            finally
            {
                await client.disconnect();
            }
        },
        async shutdown(): Promise<void>
        {
            if (!persistentPoolHandle)
            {
                return;
            }

            const handle = persistentPoolHandle;
            persistentPoolHandle = null;
            await handle.release();
        },
    });

    return provider as CodexProvider;
}

export const codexAppServer = createCodexAppServer();

/**
 * Backward-compatible alias kept during migration from scaffold naming.
 */
export const createCodexProvider = createCodexAppServer;
