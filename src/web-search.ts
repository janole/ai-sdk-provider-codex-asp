import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import type { ThreadItem } from "./protocol/app-server-protocol/v2/ThreadItem";
import type { WebSearchAction } from "./protocol/app-server-protocol/v2/WebSearchAction";
import { CODEX_PROVIDER_ID } from "./protocol/provider-metadata";

type ToolCallPart = Extract<LanguageModelV3StreamPart, { type: "tool-call" }>;
type ToolResultPart = Extract<LanguageModelV3StreamPart, { type: "tool-result" }>;
type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;

type WebSearchPayload = {
    query?: string;
    action?: WebSearchAction | null;
};

type WebSearchResultPayload = WebSearchPayload & {
    output?: string;
    summary?: string;
};

/** Typed web-search action exposed to consumers. */
export type CodexWebSearchAction =
  | { type: "search"; query?: string; queries?: string[] }
  | { type: "openPage"; url?: string }
  | { type: "findInPage"; url?: string; pattern?: string }
  | { type: "other" };

/** Parsed `codex_web_search` tool-call payload. */
export type CodexWebSearchToolCall = {
    toolCallId: string;
    toolName: "codex_web_search";
    input: {
        query?: string;
        action?: CodexWebSearchAction;
    };
};

/** Parsed `codex_web_search` tool-result payload. */
export type CodexWebSearchToolResult = {
    toolCallId: string;
    toolName: "codex_web_search";
    result: {
        output: string;
        query?: string;
        action?: CodexWebSearchAction;
        summary?: string;
    };
};

function parseJson<T>(value: string): T | undefined
{
    try
    {
        return JSON.parse(value) as T;
    }
    catch
    {
        return undefined;
    }
}

function extractMetadataItem(part: ToolCallPart | ToolResultPart): WebSearchItem | undefined
{
    const providerMetadata = part.providerMetadata?.[CODEX_PROVIDER_ID];

    if (!providerMetadata || typeof providerMetadata !== "object" || !("item" in providerMetadata))
    {
        return undefined;
    }

    const item = (providerMetadata as { item?: unknown }).item;

    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "webSearch")
    {
        return undefined;
    }

    return item as WebSearchItem;
}

function toAction(action: WebSearchAction | null | undefined): CodexWebSearchAction | undefined
{
    if (!action)
    {
        return undefined;
    }

    switch (action.type)
    {
        case "search": {
            return {
                type: "search",
                ...(action.query ? { query: action.query } : {}),
                ...(action.queries?.length ? { queries: action.queries } : {}),
            };
        }
        case "openPage": {
            return {
                type: "openPage",
                ...(action.url ? { url: action.url } : {}),
            };
        }
        case "findInPage": {
            return {
                type: "findInPage",
                ...(action.url ? { url: action.url } : {}),
                ...(action.pattern ? { pattern: action.pattern } : {}),
            };
        }
        case "other": {
            return { type: "other" };
        }
    }
}

/** Parses a Vercel tool-call part for `codex_web_search`. */
export function parseToolCall(part: ToolCallPart): CodexWebSearchToolCall | undefined
{
    if (part.toolName !== "codex_web_search")
    {
        return undefined;
    }

    const item = extractMetadataItem(part);
    const payload = item ?? (typeof part.input === "string"
        ? parseJson<WebSearchPayload>(part.input)
        : undefined);

    if (!payload)
    {
        return undefined;
    }

    const action = toAction(payload.action);

    return {
        toolCallId: part.toolCallId,
        toolName: "codex_web_search",
        input: {
            ...(payload.query ? { query: payload.query } : {}),
            ...(action ? { action } : {}),
        },
    };
}

/** Parses a Vercel tool-result part for `codex_web_search`. */
export function parseToolResult(part: ToolResultPart): CodexWebSearchToolResult | undefined
{
    if (part.toolName !== "codex_web_search")
    {
        return undefined;
    }

    const item = extractMetadataItem(part);
    const payload = item
        ? { output: (part.result as WebSearchResultPayload).output, summary: (part.result as WebSearchResultPayload).summary, ...item }
        : part.result as WebSearchResultPayload;
    const action = toAction(payload.action);

    return {
        toolCallId: part.toolCallId,
        toolName: "codex_web_search",
        result: {
            output: payload.output ?? "",
            ...(payload.query ? { query: payload.query } : {}),
            ...(action ? { action } : {}),
            ...(payload.summary ? { summary: payload.summary } : {}),
        },
    };
}
