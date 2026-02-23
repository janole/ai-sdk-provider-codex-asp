import { describe, expect, it } from "vitest";

import { CodexEventMapper } from "../src/protocol/event-mapper";

describe("CodexEventMapper", () => 
{
    it("maps assistant message lifecycle to text stream parts", () => 
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turnId: "turn" } },
            {
                method: "item/started",
                params: { threadId: "thr", turnId: "turn", itemId: "item1", itemType: "assistantMessage" },
            },
            {
                method: "item/agentMessage/delta",
                params: { threadId: "thr", turnId: "turn", itemId: "item1", delta: "Hello" },
            },
            {
                method: "item/completed",
                params: { threadId: "thr", turnId: "turn", itemId: "item1", itemType: "assistantMessage" },
            },
            {
                method: "turn/completed",
                params: { threadId: "thr", turnId: "turn", status: "completed" as const },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "item1" },
            { type: "text-delta", id: "item1", delta: "Hello" },
            { type: "text-end", id: "item1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: {
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
                },
            },
        ]);
    });

    it("maps reasoning and progress notifications to reasoning stream parts", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turnId: "turn" } },
            {
                method: "item/started",
                params: { threadId: "thr", turnId: "turn", itemId: "reason_1", itemType: "reasoning" },
            },
            {
                method: "item/reasoning/textDelta",
                params: { threadId: "thr", turnId: "turn", itemId: "reason_1", delta: "Thinking", contentIndex: 0 },
            },
            {
                method: "item/plan/delta",
                params: { threadId: "thr", turnId: "turn", itemId: "plan_1", delta: "1. Inspect code" },
            },
            {
                method: "item/commandExecution/outputDelta",
                params: { threadId: "thr", turnId: "turn", itemId: "cmd_1", delta: "npm test\\n" },
            },
            {
                method: "item/fileChange/outputDelta",
                params: { threadId: "thr", turnId: "turn", itemId: "file_1", delta: "Updated src/model.ts" },
            },
            {
                method: "item/mcpToolCall/progress",
                params: { threadId: "thr", turnId: "turn", itemId: "mcp_1", message: "Searching docs..." },
            },
            {
                method: "item/completed",
                params: { threadId: "thr", turnId: "turn", itemId: "reason_1", itemType: "reasoning" },
            },
            {
                method: "turn/completed",
                params: { threadId: "thr", turnId: "turn", status: "completed" as const },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "reason_1" },
            { type: "reasoning-delta", id: "reason_1", delta: "Thinking" },
            { type: "reasoning-start", id: "plan_1" },
            { type: "reasoning-delta", id: "plan_1", delta: "1. Inspect code" },
            { type: "reasoning-start", id: "cmd_1" },
            { type: "reasoning-delta", id: "cmd_1", delta: "npm test\\n" },
            { type: "reasoning-start", id: "file_1" },
            { type: "reasoning-delta", id: "file_1", delta: "Updated src/model.ts" },
            { type: "reasoning-start", id: "mcp_1" },
            { type: "reasoning-delta", id: "mcp_1", delta: "Searching docs..." },
            { type: "reasoning-end", id: "reason_1" },
            { type: "reasoning-end", id: "plan_1" },
            { type: "reasoning-end", id: "cmd_1" },
            { type: "reasoning-end", id: "file_1" },
            { type: "reasoning-end", id: "mcp_1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: {
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
                },
            },
        ]);
    });
});
