import type { LanguageModelV3Usage } from "@ai-sdk/provider";

// Converts `foo: T | undefined` into `foo?: T` while keeping non-undefined keys required.
type StripUndefined<T extends Record<string, unknown>> = {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
    [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

// Runtime helper that drops `undefined` values and returns the narrowed object type above.
export function stripUndefined<T extends Record<string, unknown>>(obj: T): StripUndefined<T>
{
    return Object.fromEntries(
        Object.entries(obj).filter(([, value]) => value !== undefined),
    ) as StripUndefined<T>;
}

/** Shared empty usage object for stream parts that carry no token-usage data. */
export const EMPTY_USAGE: LanguageModelV3Usage = {
    inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
    },
    outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined,
    },
};
