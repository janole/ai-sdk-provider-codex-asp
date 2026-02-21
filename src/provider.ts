import { NoSuchModelError, type ProviderV3 } from '@ai-sdk/provider';

import type { CodexTransport } from './client/transport';
import type { StdioTransportSettings } from './client/transport-stdio';
import type { WebSocketTransportSettings } from './client/transport-websocket';
import type { DynamicToolHandler } from './dynamic-tools';
import { CodexLanguageModel, type CodexLanguageModelSettings, type CodexThreadDefaults } from './model';

const PROVIDER_ID = 'codex-app-server' as const;

export interface CodexProviderSettings {
  defaultModel?: string;
  clientInfo?: {
    name: string;
    version: string;
    title?: string;
  };
  experimentalApi?: boolean;
  transport?: {
    type?: 'stdio' | 'websocket';
    stdio?: StdioTransportSettings;
    websocket?: WebSocketTransportSettings;
  };
  defaultThreadSettings?: CodexThreadDefaults;
  transportFactory?: () => CodexTransport;
  toolHandlers?: Record<string, DynamicToolHandler>;
  toolTimeoutMs?: number;
}

export interface CodexProvider extends ProviderV3 {
  (
    modelId: string,
    settings?: CodexLanguageModelSettings,
  ): CodexLanguageModel;
  chat(modelId: string, settings?: CodexLanguageModelSettings): CodexLanguageModel;
  readonly settings: Readonly<CodexProviderSettings>;
}

function createNoSuchModelError(
  modelId: string,
  modelType: 'embeddingModel' | 'imageModel',
): NoSuchModelError {
  return new NoSuchModelError({ modelId, modelType });
}

export function createCodexAppServer(
  settings: CodexProviderSettings = {},
): CodexProvider {
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
    ...(settings.transportFactory
      ? { transportFactory: settings.transportFactory }
      : {}),
    ...(settings.toolHandlers
      ? { toolHandlers: { ...settings.toolHandlers } }
      : {}),
    ...(settings.toolTimeoutMs !== undefined
      ? { toolTimeoutMs: settings.toolTimeoutMs }
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
    specificationVersion: 'v3' as const,
    settings: resolvedSettings,
    languageModel(modelId: string): CodexLanguageModel {
      return createLanguageModel(modelId);
    },
    chat(
      modelId: string,
      modelSettings: CodexLanguageModelSettings = {},
    ): CodexLanguageModel {
      return createLanguageModel(modelId, modelSettings);
    },
    embeddingModel(modelId: string) {
      throw createNoSuchModelError(modelId, 'embeddingModel');
    },
    imageModel(modelId: string) {
      throw createNoSuchModelError(modelId, 'imageModel');
    },
  });

  return provider as CodexProvider;
}

export const codexAppServer = createCodexAppServer();

/**
 * Backward-compatible alias kept during migration from scaffold naming.
 */
export const createCodexProvider = createCodexAppServer;
