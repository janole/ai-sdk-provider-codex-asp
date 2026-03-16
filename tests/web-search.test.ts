import { describe, expect, it } from "vitest";

import { parseToolCall, parseToolResult } from "../src/web-search";

describe("web-search tool parsers", () =>
{
    it("parses codex_web_search tool-call parts", () =>
    {
        const parsed = parseToolCall({
            type: "tool-call",
            toolCallId: "ws_123",
            toolName: "codex_web_search",
            input: JSON.stringify({
                query: "weather: Berlin, Germany",
                action: {
                    type: "search",
                    query: "weather: Berlin, Germany",
                    queries: ["weather: Berlin, Germany"],
                },
            }),
            providerExecuted: true,
            dynamic: true,
            providerMetadata: {
                "@janole/ai-sdk-provider-codex-asp": {
                    threadId: "thr_123",
                    turnId: "turn_123",
                    item: {
                        type: "webSearch",
                        id: "ws_123",
                        query: "weather: Berlin, Germany",
                        action: {
                            type: "search",
                            query: "weather: Berlin, Germany",
                            queries: ["weather: Berlin, Germany"],
                        },
                    },
                },
            },
        });

        expect(parsed).toEqual({
            toolCallId: "ws_123",
            toolName: "codex_web_search",
            input: {
                query: "weather: Berlin, Germany",
                action: {
                    type: "search",
                    query: "weather: Berlin, Germany",
                    queries: ["weather: Berlin, Germany"],
                },
            },
        });
    });

    it("parses codex_web_search tool-result parts", () =>
    {
        const parsed = parseToolResult({
            type: "tool-result",
            toolCallId: "ws_123",
            toolName: "codex_web_search",
            result: {
                output: "Web search: weather: Berlin, Germany",
                query: "weather: Berlin, Germany",
                action: {
                    type: "search",
                    query: "weather: Berlin, Germany",
                    queries: ["weather: Berlin, Germany"],
                },
                summary: "Web search: weather: Berlin, Germany",
            },
            providerMetadata: {
                "@janole/ai-sdk-provider-codex-asp": {
                    threadId: "thr_123",
                    turnId: "turn_123",
                    item: {
                        type: "webSearch",
                        id: "ws_123",
                        query: "weather: Berlin, Germany",
                        action: {
                            type: "search",
                            query: "weather: Berlin, Germany",
                            queries: ["weather: Berlin, Germany"],
                        },
                    },
                },
            },
        });

        expect(parsed).toEqual({
            toolCallId: "ws_123",
            toolName: "codex_web_search",
            result: {
                output: "Web search: weather: Berlin, Germany",
                query: "weather: Berlin, Germany",
                action: {
                    type: "search",
                    query: "weather: Berlin, Germany",
                    queries: ["weather: Berlin, Germany"],
                },
                summary: "Web search: weather: Berlin, Germany",
            },
        });
    });
});
