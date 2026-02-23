import { describe, expect, it } from "vitest";

import { CodexEventMapper } from "../src/protocol/event-mapper";

const EMPTY_USAGE = {
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

describe("CodexEventMapper", () =>
{
    it("maps agent message lifecycle to text stream parts", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turnId: "turn" } },
            {
                method: "item/started",
                params: {
                    item: { type: "agentMessage", id: "item1", text: "" },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/agentMessage/delta",
                params: { threadId: "thr", turnId: "turn", itemId: "item1", delta: "Hello" },
            },
            {
                method: "item/completed",
                params: {
                    item: { type: "agentMessage", id: "item1", text: "Hello" },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn", items: [], status: "completed" as const, error: null },
                },
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
                usage: EMPTY_USAGE,
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
                params: {
                    item: { type: "reasoning", id: "reason_1", summary: [], content: [] },
                    threadId: "thr",
                    turnId: "turn",
                },
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
                method: "item/fileChange/outputDelta",
                params: { threadId: "thr", turnId: "turn", itemId: "file_1", delta: "Updated src/model.ts" },
            },
            {
                method: "item/mcpToolCall/progress",
                params: { threadId: "thr", turnId: "turn", itemId: "mcp_1", message: "Searching docs..." },
            },
            {
                method: "item/completed",
                params: {
                    item: { type: "reasoning", id: "reason_1", summary: [], content: [] },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "reason_1" },
            { type: "reasoning-delta", id: "reason_1", delta: "Thinking" },
            { type: "reasoning-start", id: "plan_1" },
            { type: "reasoning-delta", id: "plan_1", delta: "1. Inspect code" },
            { type: "reasoning-start", id: "file_1" },
            { type: "reasoning-delta", id: "file_1", delta: "Updated src/model.ts" },
            { type: "reasoning-start", id: "mcp_1" },
            { type: "reasoning-delta", id: "mcp_1", delta: "Searching docs..." },
            { type: "reasoning-end", id: "reason_1" },
            { type: "reasoning-end", id: "plan_1" },
            { type: "reasoning-end", id: "file_1" },
            { type: "reasoning-end", id: "mcp_1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("maps commandExecution to provider-executed tool-call and tool-result stream", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turnId: "turn" } },
            {
                method: "item/started",
                params: {
                    item: {
                        type: "commandExecution",
                        id: "cmd_1",
                        command: "npm test",
                        cwd: "/project",
                        processId: null,
                        status: "inProgress",
                        commandActions: [],
                        aggregatedOutput: null,
                        exitCode: null,
                        durationMs: null,
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/commandExecution/outputDelta",
                params: { threadId: "thr", turnId: "turn", itemId: "cmd_1", delta: "PASS " },
            },
            {
                method: "item/commandExecution/outputDelta",
                params: { threadId: "thr", turnId: "turn", itemId: "cmd_1", delta: "src/test.ts" },
            },
            {
                method: "item/completed",
                params: {
                    item: {
                        type: "commandExecution",
                        id: "cmd_1",
                        command: "npm test",
                        cwd: "/project",
                        processId: "123",
                        status: "completed",
                        commandActions: [],
                        aggregatedOutput: "PASS src/test.ts",
                        exitCode: 0,
                        durationMs: 1500,
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "tool-call",
                toolCallId: "cmd_1",
                toolName: "codex_command_execution",
                input: JSON.stringify({ command: "npm test", cwd: "/project" }),
                providerExecuted: true,
                dynamic: true,
            },
            {
                type: "tool-result",
                toolCallId: "cmd_1",
                toolName: "codex_command_execution",
                result: { output: "PASS " },
                preliminary: true,
            },
            {
                type: "tool-result",
                toolCallId: "cmd_1",
                toolName: "codex_command_execution",
                result: { output: "PASS src/test.ts" },
                preliminary: true,
            },
            {
                type: "tool-result",
                toolCallId: "cmd_1",
                toolName: "codex_command_execution",
                result: { output: "PASS src/test.ts", exitCode: 0, status: "completed" },
            },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("cleans up orphaned command tool calls on turn/completed", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turnId: "turn" } },
            {
                method: "item/started",
                params: {
                    item: {
                        type: "commandExecution",
                        id: "cmd_orphan",
                        command: "ls -la",
                        cwd: "/tmp",
                        processId: null,
                        status: "inProgress",
                        commandActions: [],
                        aggregatedOutput: null,
                        exitCode: null,
                        durationMs: null,
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/commandExecution/outputDelta",
                params: { threadId: "thr", turnId: "turn", itemId: "cmd_orphan", delta: "file1.txt\n" },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "tool-call",
                toolCallId: "cmd_orphan",
                toolName: "codex_command_execution",
                input: JSON.stringify({ command: "ls -la", cwd: "/tmp" }),
                providerExecuted: true,
                dynamic: true,
            },
            {
                type: "tool-result",
                toolCallId: "cmd_orphan",
                toolName: "codex_command_execution",
                result: { output: "file1.txt\n" },
                preliminary: true,
            },
            {
                type: "tool-result",
                toolCallId: "cmd_orphan",
                toolName: "codex_command_execution",
                result: { output: "file1.txt\n" },
            },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("maps new item types (webSearch, collabAgentToolCall) to reasoning parts", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turnId: "turn" } },
            {
                method: "item/started",
                params: {
                    item: { type: "webSearch", id: "ws_1", query: "vitest docs", action: null },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/started",
                params: {
                    item: {
                        type: "collabAgentToolCall",
                        id: "collab_1",
                        tool: { type: "ask" },
                        status: "inProgress",
                        senderThreadId: "thr",
                        receiverThreadIds: [],
                        prompt: null,
                        agentsStates: {},
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/completed",
                params: {
                    item: { type: "webSearch", id: "ws_1", query: "vitest docs", action: null },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/completed",
                params: {
                    item: {
                        type: "collabAgentToolCall",
                        id: "collab_1",
                        tool: { type: "ask" },
                        status: "completed",
                        senderThreadId: "thr",
                        receiverThreadIds: [],
                        prompt: null,
                        agentsStates: {},
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "ws_1" },
            { type: "reasoning-start", id: "collab_1" },
            { type: "reasoning-end", id: "ws_1" },
            { type: "reasoning-end", id: "collab_1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("populates finish usage from thread/tokenUsage/updated", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turnId: "turn" } },
            {
                method: "item/started",
                params: {
                    item: { type: "agentMessage", id: "item1", text: "" },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/agentMessage/delta",
                params: { threadId: "thr", turnId: "turn", itemId: "item1", delta: "Hi" },
            },
            {
                method: "thread/tokenUsage/updated",
                params: {
                    threadId: "thr",
                    turnId: "turn",
                    tokenUsage: {
                        total: { totalTokens: 2000, inputTokens: 1500, cachedInputTokens: 500, outputTokens: 500, reasoningOutputTokens: 100 },
                        last: { totalTokens: 800, inputTokens: 600, cachedInputTokens: 200, outputTokens: 200, reasoningOutputTokens: 50 },
                        modelContextWindow: 128000,
                    },
                },
            },
            {
                method: "item/completed",
                params: {
                    item: { type: "agentMessage", id: "item1", text: "Hi" },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        const finish = parts.find((p) => p.type === "finish");
        expect(finish).toEqual({
            type: "finish",
            finishReason: { unified: "stop", raw: "completed" },
            usage: {
                inputTokens: {
                    total: 600,
                    noCache: undefined,
                    cacheRead: 200,
                    cacheWrite: undefined,
                },
                outputTokens: {
                    total: 200,
                    text: undefined,
                    reasoning: 50,
                },
            },
        });
    });

    it("maps mcpToolCall item/started and item/completed with nested shape", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turnId: "turn" } },
            {
                method: "item/started",
                params: {
                    item: {
                        type: "mcpToolCall",
                        id: "mcp_1",
                        server: "docs-server",
                        tool: "search",
                        status: "inProgress",
                        arguments: { query: "test" },
                        result: null,
                        error: null,
                        durationMs: null,
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/mcpToolCall/progress",
                params: { threadId: "thr", turnId: "turn", itemId: "mcp_1", message: "Searching..." },
            },
            {
                method: "item/completed",
                params: {
                    item: {
                        type: "mcpToolCall",
                        id: "mcp_1",
                        server: "docs-server",
                        tool: "search",
                        status: "completed",
                        arguments: { query: "test" },
                        result: { content: [{ type: "text", text: "found" }], isError: false },
                        error: null,
                        durationMs: 250,
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "mcp_1" },
            { type: "reasoning-delta", id: "mcp_1", delta: "Searching..." },
            { type: "reasoning-end", id: "mcp_1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });
});
