import type { CodexProvider, CodexProviderConfig } from './types';

const PROVIDER_NAME = 'codex-ai-sdk-provider' as const;

/**
 * Creates a Codex AI SDK provider instance.
 *
 * This is a scaffold implementation and will be extended with
 * Vercel AI SDK v6 provider behaviors in subsequent steps.
 */
export function createCodexProvider(config: CodexProviderConfig): CodexProvider {
  if (!config.baseUrl || config.baseUrl.trim().length === 0) {
    throw new Error('createCodexProvider: "baseUrl" is required.');
  }

  return {
    name: PROVIDER_NAME,
    config: Object.freeze({
      ...config,
      headers: { ...(config.headers ?? {}) },
    }),
  };
}
