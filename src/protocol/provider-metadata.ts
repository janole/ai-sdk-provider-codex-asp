import type { LanguageModelV3StreamPart, SharedV3ProviderOptions } from "@ai-sdk/provider";

import type { CodexCallOptions } from "../provider-settings";
import { stripUndefined } from "../utils/object";

export const CODEX_PROVIDER_ID = "@janole/ai-sdk-provider-codex-asp";

export function codexProviderMetadata(threadId: string | undefined, turnId?: string)
{
    if (!threadId)
    {
        return undefined;
    }

    return { [CODEX_PROVIDER_ID]: stripUndefined({ threadId, turnId }) };
}

export function codexCallOptions(options: CodexCallOptions): SharedV3ProviderOptions
{
    return { [CODEX_PROVIDER_ID]: options as SharedV3ProviderOptions[string] };
}

export function withProviderMetadata<T extends LanguageModelV3StreamPart>(
    part: T,
    threadId: string | undefined,
    turnId?: string,
): T
{
    const meta = codexProviderMetadata(threadId, turnId);
    return meta ? { ...part, providerMetadata: meta } : part;
}
