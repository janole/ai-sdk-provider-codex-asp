import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import { stripUndefined } from "../utils/object";

export const CODEX_PROVIDER_ID = "@janole/ai-sdk-provider-codex-asp";

type CodexProviderExtraMetadata = Record<string, unknown>;

export function codexProviderMetadata(
    threadId: string | undefined,
    turnId?: string,
    extra?: CodexProviderExtraMetadata,
)
{
    if (!threadId && !extra)
    {
        return undefined;
    }

    return { [CODEX_PROVIDER_ID]: stripUndefined({ threadId, turnId, ...extra }) };
}

export function withProviderMetadata<T extends LanguageModelV3StreamPart>(
    part: T,
    threadId: string | undefined,
    turnId?: string,
    extra?: CodexProviderExtraMetadata,
): T
{
    const meta = codexProviderMetadata(threadId, turnId, extra);
    return meta ? { ...part, providerMetadata: meta } : part;
}
