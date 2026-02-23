import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

export const CODEX_PROVIDER_ID = "codex-app-server";

export function codexProviderMetadata(threadId: string | undefined)
{
    if (!threadId)
    {
        return undefined;
    }

    return { [CODEX_PROVIDER_ID]: { threadId } };
}

export function withProviderMetadata<T extends LanguageModelV3StreamPart>(
    part: T,
    threadId: string | undefined,
): T
{
    const meta = codexProviderMetadata(threadId);
    return meta ? { ...part, providerMetadata: meta } : part;
}
