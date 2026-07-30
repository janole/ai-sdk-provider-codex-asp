import type { JSONValue, LanguageModelV3StreamPart, SharedV3ProviderOptions } from "@ai-sdk/provider";

import type { CodexCallOptions } from "../provider-settings";
import { stripUndefined } from "../utils/object";

export const CODEX_PROVIDER_ID = "@janole/ai-sdk-provider-codex-asp";

export function codexProviderMetadata(
    threadId: string | undefined,
    turnId?: string,
    threadPath?: string,
    extra?: Record<string, JSONValue>,
)
{
    const hasExtra = extra !== null && extra !== undefined && Object.keys(extra).length > 0;
    if (!threadId && !hasExtra)
    {
        return undefined;
    }

    return { [CODEX_PROVIDER_ID]: { ...stripUndefined({ threadId, turnId, threadPath }), ...(extra ?? {}) } };
}

export function codexCallOptions(options: CodexCallOptions): SharedV3ProviderOptions
{
    return { [CODEX_PROVIDER_ID]: options as SharedV3ProviderOptions[string] };
}

export function withProviderMetadata<T extends LanguageModelV3StreamPart>(
    part: T,
    threadId: string | undefined,
    turnId?: string,
    threadPath?: string,
    extra?: Record<string, JSONValue>,
): T
{
    const providerMetadata = codexProviderMetadata(threadId, turnId, threadPath, extra);
    if (!providerMetadata)
    {
        return part;
    }
    return { ...part, providerMetadata };
}
