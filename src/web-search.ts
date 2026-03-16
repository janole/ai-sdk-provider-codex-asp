import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

type JsonRecord = Record<string, unknown>;
type ToolCallPart = Extract<LanguageModelV3StreamPart, { type: "tool-call" }>;
type ToolResultPart = Extract<LanguageModelV3StreamPart, { type: "tool-result" }>;

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

function asRecord(value: unknown): JsonRecord | undefined
{
    if (typeof value !== "object" || value === null || Array.isArray(value))
    {
        return undefined;
    }

    return value as JsonRecord;
}

function asString(value: unknown): string | undefined
{
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined
{
    if (!Array.isArray(value))
    {
        return undefined;
    }

    const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

    return strings.length > 0 ? strings : undefined;
}

function parseJson(value: unknown): unknown
{
    if (typeof value !== "string")
    {
        return value;
    }

    try
    {
        return JSON.parse(value) as unknown;
    }
    catch
    {
        return value;
    }
}

function parseAction(value: unknown): CodexWebSearchAction | undefined
{
    const action = asRecord(value);

    if (!action || typeof action.type !== "string")
    {
        return undefined;
    }

    switch (action.type)
    {
        case "search": {
            const query = asString(action.query);
            const queries = asStringArray(action.queries);

            return {
                type: "search",
                ...(query ? { query } : {}),
                ...(queries ? { queries } : {}),
            };
        }
        case "openPage":
        case "open_page": {
            const url = asString(action.url);

            return {
                type: "openPage",
                ...(url ? { url } : {}),
            };
        }
        case "findInPage":
        case "find_in_page": {
            const url = asString(action.url);
            const pattern = asString(action.pattern);

            return {
                type: "findInPage",
                ...(url ? { url } : {}),
                ...(pattern ? { pattern } : {}),
            };
        }
        case "other": {
            return { type: "other" };
        }
        default: {
            return undefined;
        }
    }
}

function parseInput(value: unknown): CodexWebSearchToolCall["input"] | undefined
{
    const input = asRecord(parseJson(value));

    if (!input)
    {
        return undefined;
    }

    const query = asString(input.query);
    const action = parseAction(input.action);

    if (!query && !action)
    {
        return undefined;
    }

    return {
        ...(query ? { query } : {}),
        ...(action ? { action } : {}),
    };
}

function parseResultPayload(value: unknown): CodexWebSearchToolResult["result"] | undefined
{
    const result = asRecord(parseJson(value));

    if (!result)
    {
        return undefined;
    }

    const payload = result.type === "json" ? asRecord(result.value) ?? result : result;
    const output = asString(payload.output) ?? "";
    const query = asString(payload.query);
    const action = parseAction(payload.action);
    const summary = asString(payload.summary);

    if (!output && !query && !action && !summary)
    {
        return undefined;
    }

    return {
        output,
        ...(query ? { query } : {}),
        ...(action ? { action } : {}),
        ...(summary ? { summary } : {}),
    };
}

/** Parses a Vercel tool-call part for `codex_web_search`. */
export function parseToolCall(part: ToolCallPart): CodexWebSearchToolCall | undefined
{
    if (part.toolName !== "codex_web_search")
    {
        return undefined;
    }

    const input = parseInput(part.input);

    if (!input)
    {
        return undefined;
    }

    return {
        toolCallId: part.toolCallId,
        toolName: "codex_web_search",
        input,
    };
}

/** Parses a Vercel tool-result part for `codex_web_search`. */
export function parseToolResult(part: ToolResultPart): CodexWebSearchToolResult | undefined
{
    if (part.toolName !== "codex_web_search")
    {
        return undefined;
    }

    const result = parseResultPayload(part.result);

    if (!result)
    {
        return undefined;
    }

    return {
        toolCallId: part.toolCallId,
        toolName: "codex_web_search",
        result,
    };
}
