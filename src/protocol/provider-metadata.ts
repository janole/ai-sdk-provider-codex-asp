import type { LanguageModelV3StreamPart, SharedV3ProviderOptions } from "@ai-sdk/provider";

import type { CodexCallOptions } from "../provider-settings";
import { stripUndefined } from "../utils/object";

export const CODEX_PROVIDER_ID = "@janole/ai-sdk-provider-codex-asp";

export function codexProviderMetadata(threadId: string | undefined, turnId?: string, threadPath?: string)
{
    if (!threadId)
    {
        return undefined;
    }

    return { [CODEX_PROVIDER_ID]: stripUndefined({ threadId, turnId, threadPath }) };
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
    extra?: Record<string, string>,
): T
{
    const hasExtra = extra !== null && extra !== undefined && Object.keys(extra).length > 0;
    if (!threadId && !hasExtra)
    {
        return part;
    }
    const entry = { ...stripUndefined({ threadId, turnId, threadPath }), ...(extra ?? {}) };
    return { ...part, providerMetadata: { [CODEX_PROVIDER_ID]: entry } };
}
