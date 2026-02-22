import { NoSuchModelError, type ProviderV3 } from "@ai-sdk/provider";

import type { CodexTransport } from "./client/transport";
import { PersistentTransport } from "./client/transport-persistent";
import type { StdioTransportSettings } from "./client/transport-stdio";
import type { WebSocketTransportSettings } from "./client/transport-websocket";
import { CodexWorkerPool } from "./client/worker-pool";
import type { CommandApprovalHandler, FileChangeApprovalHandler } from "./approvals";
import type { DynamicToolDefinition, DynamicToolHandler } from "./dynamic-tools";
import { CodexProviderError } from "./errors";
import { CodexLanguageModel, type CodexLanguageModelSettings, type CodexThreadDefaults } from "./model";

const PROVIDER_ID = "codex-app-server" as const;

export interface CodexProviderSettings {
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
    /** Tools with schema (description + inputSchema) advertised to Codex + local handlers. */
    tools?: Record<string, DynamicToolDefinition>;
    /** Legacy: handler-only tools, not advertised to Codex. Use `tools` for full schema support. */
    toolHandlers?: Record<string, DynamicToolHandler>;
    toolTimeoutMs?: number;
    approvals?: {
        onCommandApproval?: CommandApprovalHandler;
        onFileChangeApproval?: FileChangeApprovalHandler;
    };
    persistent?: {
        poolSize?: number;
        idleTimeoutMs?: number;
    };
}

export interface CodexProvider extends ProviderV3 {
    (
        modelId: string,
        settings?: CodexLanguageModelSettings,
    ): CodexLanguageModel;
    chat(modelId: string, settings?: CodexLanguageModelSettings): CodexLanguageModel;
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
    let pool: CodexWorkerPool | null = null;

    const baseTransportFactory = settings.transportFactory;

    if (settings.persistent)
    {
        if (!baseTransportFactory)
        {
            throw new CodexProviderError(
                "persistent mode requires a transportFactory to be set.",
            );
        }

        pool = new CodexWorkerPool({
            ...(settings.persistent.poolSize !== undefined
                ? { poolSize: settings.persistent.poolSize }
                : {}),
            transportFactory: baseTransportFactory,
            ...(settings.persistent.idleTimeoutMs !== undefined
                ? { idleTimeoutMs: settings.persistent.idleTimeoutMs }
                : {}),
        });
    }

    const effectiveTransportFactory = pool
        ? () => new PersistentTransport({ pool: pool! })
        : baseTransportFactory;

    const resolvedSettings: Readonly<CodexProviderSettings> = Object.freeze({
        ...(settings.defaultModel ? { defaultModel: settings.defaultModel } : {}),
        ...(settings.experimentalApi !== undefined
            ? { experimentalApi: settings.experimentalApi }
            : {}),
        ...(settings.clientInfo
            ? {
                clientInfo: {
                    ...settings.clientInfo,
                },
            }
            : {}),
        ...(settings.transport
            ? {
                transport: {
                    ...(settings.transport.type ? { type: settings.transport.type } : {}),
                    ...(settings.transport.stdio
                        ? { stdio: { ...settings.transport.stdio } }
                        : {}),
                    ...(settings.transport.websocket
                        ? { websocket: { ...settings.transport.websocket } }
                        : {}),
                },
            }
            : {}),
        ...(settings.defaultThreadSettings
            ? { defaultThreadSettings: { ...settings.defaultThreadSettings } }
            : {}),
        ...(effectiveTransportFactory
            ? { transportFactory: effectiveTransportFactory }
            : {}),
        ...(settings.tools
            ? { tools: { ...settings.tools } }
            : {}),
        ...(settings.toolHandlers
            ? { toolHandlers: { ...settings.toolHandlers } }
            : {}),
        ...(settings.toolTimeoutMs !== undefined
            ? { toolTimeoutMs: settings.toolTimeoutMs }
            : {}),
        ...(settings.approvals
            ? { approvals: { ...settings.approvals } }
            : {}),
    });

    const createLanguageModel = (
        modelId: string,
        modelSettings: CodexLanguageModelSettings = {},
    ): CodexLanguageModel =>
        new CodexLanguageModel(modelId, modelSettings, {
            provider: PROVIDER_ID,
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
        async shutdown(): Promise<void>
        {
            if (pool)
            {
                await pool.shutdown();
            }
        },
    });

    return provider as CodexProvider;
}

export const codexAppServer = createCodexAppServer();

/**
 * Backward-compatible alias kept during migration from scaffold naming.
 */
export const createCodexProvider = createCodexAppServer;
