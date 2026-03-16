type JsonRecord = Record<string, unknown>;

/** Consumer-facing web-search action shape with normalized camelCase variants. */
export type CodexWebSearchAction =
  | { type: "search"; query?: string; queries?: string[] }
  | { type: "openPage"; url?: string }
  | { type: "findInPage"; url?: string; pattern?: string }
  | { type: "other" };

/** Consumer-facing tool input for `codex_web_search`. */
export type CodexWebSearchToolInput = {
    query?: string;
    action?: CodexWebSearchAction;
};

/** Consumer-facing tool result for `codex_web_search`. */
export type CodexWebSearchToolResult = {
    output: string;
    query?: string;
    action?: CodexWebSearchAction;
    summary?: string;
};

type WebSearchLike = {
    query?: string;
    action?: unknown;
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

function unwrapItem(value: unknown): JsonRecord | undefined
{
    const record = asRecord(value);

    if (!record)
    {
        return undefined;
    }

    if (record.direction === "inbound")
    {
        const message = asRecord(record.message);
        const params = asRecord(message?.params);
        const item = asRecord(params?.item);

        if (item)
        {
            return item;
        }
    }

    return record;
}

function normalizeActionRecord(action: JsonRecord | undefined): CodexWebSearchAction | undefined
{
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
        case "open_page":
        case "openPage": {
            const url = asString(action.url);

            return {
                type: "openPage",
                ...(url ? { url } : {}),
            };
        }
        case "find_in_page":
        case "findInPage": {
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

/** Normalizes a generated web-search action for consumers. */
export function normalizeCodexWebSearchAction(action: unknown): CodexWebSearchAction | undefined
{
    return normalizeActionRecord(asRecord(action));
}

/** Creates a stable `codex_web_search` tool input from a protocol item. */
export function createCodexWebSearchToolInput(item: WebSearchLike): CodexWebSearchToolInput
{
    const action = normalizeCodexWebSearchAction(item.action);

    return {
        ...(item.query ? { query: item.query } : {}),
        ...(action ? { action } : {}),
    };
}

/** Creates a stable `codex_web_search` tool result from a protocol item. */
export function createCodexWebSearchToolResult(
    item: WebSearchLike,
    summary?: string,
): CodexWebSearchToolResult
{
    const action = normalizeCodexWebSearchAction(item.action);

    return {
        output: summary ?? "",
        ...(item.query ? { query: item.query } : {}),
        ...(action ? { action } : {}),
        ...(summary ? { summary } : {}),
    };
}

/** Parses `codex_web_search` tool input from either raw protocol or emitted tool payloads. */
export function parseCodexWebSearchToolInput(value: unknown): CodexWebSearchToolInput | undefined
{
    const record = unwrapItem(value);

    if (!record)
    {
        return undefined;
    }

    const query = asString(record.query);
    const action = normalizeActionRecord(asRecord(record.action));

    if (!query && !action)
    {
        return undefined;
    }

    return {
        ...(query ? { query } : {}),
        ...(action ? { action } : {}),
    };
}

/** Parses `codex_web_search` tool result from emitted tool payloads or wrapped JSON values. */
export function parseCodexWebSearchToolResult(value: unknown): CodexWebSearchToolResult | undefined
{
    const record = asRecord(value);

    if (!record)
    {
        return undefined;
    }

    const payload = record.type === "json" ? asRecord(record.value) ?? record : record;
    const parsedInput = parseCodexWebSearchToolInput(payload);
    const output = asString(payload.output) ?? "";
    const summary = asString(payload.summary);

    if (!parsedInput && !output && !summary)
    {
        return undefined;
    }

    return {
        output,
        ...(parsedInput?.query ? { query: parsedInput.query } : {}),
        ...(parsedInput?.action ? { action: parsedInput.action } : {}),
        ...(summary ? { summary } : {}),
    };
}
