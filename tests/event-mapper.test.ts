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
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
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
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
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
            { type: "reasoning-end", id: "reason_1" },
            { type: "reasoning-end", id: "plan_1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("maps fileChange lifecycle to provider-executed tool parts", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
            {
                method: "item/started",
                params: {
                    item: {
                        type: "fileChange",
                        id: "file_1",
                        status: "inProgress",
                        changes: [],
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/completed",
                params: {
                    item: {
                        type: "fileChange",
                        id: "file_1",
                        status: "completed",
                        changes: [],
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
                toolCallId: "file_1",
                toolName: "codex_file_change",
                input: JSON.stringify({ changes: [], status: "inProgress" }),
                providerExecuted: true,
                dynamic: true,
            },
            {
                type: "tool-result",
                toolCallId: "file_1",
                toolName: "codex_file_change",
                result: { item: { type: "fileChange", id: "file_1", status: "completed", changes: [] } },
            },
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
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
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
                result: {
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
                },
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
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
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
                result: { error: "Tool call did not complete before turn ended" },
                isError: true,
            },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("maps webSearch to provider-executed tool parts and keeps collabAgentToolCall as reasoning", () =>
    {
        const mapper = new CodexEventMapper();

        // Real codex flow: item/started carries an empty placeholder (query: "",
        // action: {type:"other"}); the real query + action only arrive at
        // item/completed. The placeholder is suppressed at start and the full
        // provider-executed call + result are emitted from item/completed.
        const completedItem = {
            type: "webSearch",
            id: "ws_1",
            query: "di.gg API documentation",
            action: {
                type: "search",
                query: "di.gg API documentation",
                queries: ["di.gg API documentation", "site:di.gg api", "di.gg developer docs"],
            },
        };

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
            {
                method: "item/started",
                params: {
                    item: { type: "webSearch", id: "ws_1", query: "", action: { type: "other" } },
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
                    item: completedItem,
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

        // The empty placeholder at item/started is suppressed; the tool-call carries
        // the real query/action from item/completed, paired with its result.
        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "collab_1" },
            {
                type: "tool-call",
                toolCallId: "ws_1",
                toolName: "codex_web_search",
                input: JSON.stringify({ query: completedItem.query, action: completedItem.action }),
                providerExecuted: true,
                dynamic: true,
            },
            {
                type: "tool-result",
                toolCallId: "ws_1",
                toolName: "codex_web_search",
                result: { item: completedItem },
            },
            { type: "reasoning-end", id: "collab_1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("drops an abandoned webSearch placeholder that never completes", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
            {
                method: "item/started",
                params: {
                    item: { type: "webSearch", id: "ws_ghost", query: "", action: { type: "other" } },
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

        // The placeholder is suppressed at item/started and never completes, so it
        // produces no tool-call and — crucially — no synthesized "did not complete"
        // error on turn/completed.
        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("ignores codex/event web search wrappers", () =>
    {
        const mapper = new CodexEventMapper();

        const parts = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
            {
                method: "codex/event/web_search_begin",
                params: { threadId: "thr", turnId: "turn", msg: { call_id: "ws_dup" } },
            },
            {
                method: "codex/event/web_search_end",
                params: {
                    threadId: "thr",
                    turnId: "turn",
                    msg: { call_id: "ws_dup", query: "vitest docs", action: { type: "search", query: "vitest docs" } },
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn", items: [], status: "completed" as const, error: null },
                },
            },
        ].flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("emits providerExecuted tool parts for dynamicToolCall in non-cross-call mode", () =>
    {
        const mapper = new CodexEventMapper(); // enableCrossCallMode() NOT called

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
            {
                method: "item/started",
                params: {
                    item: {
                        type: "dynamicToolCall",
                        id: "call_nc",
                        tool: "myTool",
                        arguments: { x: 1 },
                        status: "inProgress",
                        contentItems: null,
                        success: null,
                        durationMs: null,
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/completed",
                params: {
                    item: {
                        type: "dynamicToolCall",
                        id: "call_nc",
                        tool: "myTool",
                        arguments: { x: 1 },
                        status: "completed",
                        contentItems: [{ type: "inputText", text: "result" }],
                        success: true,
                        durationMs: 10,
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
                toolCallId: "call_nc",
                toolName: "myTool",
                input: JSON.stringify({ x: 1 }),
                providerExecuted: true,
                dynamic: true,
            },
            {
                type: "tool-result",
                toolCallId: "call_nc",
                toolName: "myTool",
                result: {
                    item: {
                        type: "dynamicToolCall",
                        id: "call_nc",
                        tool: "myTool",
                        arguments: { x: 1 },
                        status: "completed",
                        contentItems: [{ type: "inputText", text: "result" }],
                        success: true,
                        durationMs: 10,
                    },
                },
            },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("mapper is silent for dynamicToolCall lifecycle in cross-call mode", () =>
    {
        const mapper = new CodexEventMapper();
        mapper.enableCrossCallMode();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
            {
                method: "item/started",
                params: {
                    item: {
                        type: "dynamicToolCall",
                        id: "call_1",
                        tool: "readGithubFile",
                        arguments: { owner: "acme", repo: "widgets", path: "README.md" },
                        status: "inProgress",
                        contentItems: null,
                        success: null,
                        durationMs: null,
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            // item/tool/call fires for the same ID — mapper must stay silent (dedup via _sdkDynamicToolCallIds)
            {
                method: "item/tool/call",
                params: {
                    threadId: "thr",
                    turnId: "turn",
                    callId: "call_1",
                    tool: "readGithubFile",
                    arguments: { owner: "acme", repo: "widgets", path: "README.md" },
                },
            },
            {
                method: "item/completed",
                params: {
                    item: {
                        type: "dynamicToolCall",
                        id: "call_1",
                        tool: "readGithubFile",
                        arguments: { owner: "acme", repo: "widgets", path: "README.md" },
                        status: "completed",
                        contentItems: [{ type: "inputText", text: "file content" }],
                        success: true,
                        durationMs: 123,
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

        // In cross-call mode the mapper is fully silent for dynamicToolCall items
        // (including the item/tool/call dedup). The cross-call handler in model.ts
        // emits the definitive tool-call (no providerExecuted) + finish.
        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("maps item/tool/call to provider-executed tool-call", () =>
    {
        const mapper = new CodexEventMapper();

        const parts = mapper.map({
            method: "item/tool/call",
            params: {
                threadId: "thr",
                turnId: "turn",
                callId: "call_2",
                tool: "lookup",
                arguments: { id: "ABC-1" },
            },
        });

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "tool-call",
                toolCallId: "call_2",
                toolName: "lookup",
                input: JSON.stringify({ id: "ABC-1" }),
                providerExecuted: true,
                dynamic: true,
            },
        ]);
    });

    it("populates finish usage from thread/tokenUsage/updated", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
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
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
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
            {
                type: "tool-call",
                toolCallId: "mcp_1",
                toolName: "mcp:docs-server/search",
                input: JSON.stringify({ query: "test" }),
                providerExecuted: true,
                dynamic: true,
            },
            {
                type: "tool-result",
                toolCallId: "mcp_1",
                toolName: "mcp:docs-server/search",
                result: { output: "Searching..." },
                preliminary: true,
            },
            {
                type: "tool-result",
                toolCallId: "mcp_1",
                toolName: "mcp:docs-server/search",
                result: {
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
                },
            },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    // Turn diffs are intentionally ignored — they carry full unified diffs
    // (often 50-100 KB) that crash/freeze the frontend markdown renderer when
    // emitted as reasoning. If re-enabling, use a dedicated part type with
    // lazy/collapsed rendering instead of emitReasoningDelta.
    it("ignores turn diff notifications", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn_1" } } },
            {
                method: "turn/diff/updated",
                params: {
                    threadId: "thr",
                    turnId: "turn_1",
                    diff: "diff --git a/a.ts b/a.ts",
                },
            },
            {
                method: "codex/event/turn_diff",
                params: {
                    id: "turn_1",
                    msg: { type: "turn_diff", unified_diff: "@@ -1,1 +1,1 @@" },
                    conversationId: "thr",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn_1", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        // No reasoning parts — diffs are silently dropped.
        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("maps reasoning section break via canonical event and skips wrapper duplicate", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn_1" } } },
            {
                method: "item/reasoning/summaryTextDelta",
                params: {
                    threadId: "thr",
                    turnId: "turn_1",
                    itemId: "rs_1",
                    delta: "First section",
                },
            },
            {
                method: "item/reasoning/summaryPartAdded",
                params: {
                    threadId: "thr",
                    turnId: "turn_1",
                    itemId: "rs_1",
                    summaryIndex: 1,
                },
            },
            {
                // Wrapper duplicate of summaryPartAdded — should be ignored.
                method: "codex/event/agent_reasoning_section_break",
                params: {
                    id: "turn_1",
                    msg: {
                        type: "agent_reasoning_section_break",
                        item_id: "rs_1",
                        summary_index: 2,
                    },
                    conversationId: "thr",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn_1", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        // Only one "\n\n" — the wrapper duplicate is skipped.
        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "reasoning-start", id: "rs_1" },
            { type: "reasoning-delta", id: "rs_1", delta: "First section" },
            { type: "reasoning-delta", id: "rs_1", delta: "\n\n" },
            { type: "reasoning-end", id: "rs_1" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("ignores codex/event/agent_reasoning wrapper events", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn_ar" } } },
            {
                method: "codex/event/agent_reasoning",
                params: {
                    id: "turn_ar",
                    msg: { type: "agent_reasoning", text: "**Planning update**" },
                    conversationId: "thr",
                },
            },
            {
                method: "codex/event/agent_reasoning",
                params: {
                    id: "turn_ar",
                    msg: { type: "agent_reasoning", text: "Looking at event counts." },
                    conversationId: "thr",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn_ar", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("falls back to item/completed agent text when no deltas were emitted", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn_fb" } } },
            {
                method: "item/started",
                params: {
                    item: { type: "agentMessage", id: "msg_fb", text: "" },
                    threadId: "thr",
                    turnId: "turn_fb",
                },
            },
            // No item/agentMessage/delta events arrive.
            {
                method: "item/completed",
                params: {
                    item: { type: "agentMessage", id: "msg_fb", text: "Final answer text", phase: "final_answer" },
                    threadId: "thr",
                    turnId: "turn_fb",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn_fb", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "msg_fb" },
            // Fallback: full text emitted from item/completed since no deltas arrived.
            { type: "text-delta", id: "msg_fb", delta: "Final answer text" },
            { type: "text-end", id: "msg_fb" },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("maps plan updates as tool-call/tool-result pairs", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn_plan" } } },
            {
                method: "turn/plan/updated",
                params: {
                    threadId: "thr",
                    turnId: "turn_plan",
                    explanation: "Updating files",
                    plan: [
                        { step: "Read config", status: "completed" },
                        { step: "Update mapper", status: "in_progress" },
                    ],
                },
            },
            {
                method: "turn/plan/updated",
                params: {
                    threadId: "thr",
                    turnId: "turn_plan",
                    explanation: "Almost done",
                    plan: [
                        { step: "Read config", status: "completed" },
                        { step: "Update mapper", status: "completed" },
                    ],
                },
            },
            // Wrapper duplicate — should be silently dropped.
            {
                method: "codex/event/plan_update",
                params: {
                    id: "turn_plan",
                    msg: { type: "plan_update", plan: [] },
                    conversationId: "thr",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn_plan", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            // First plan update: tool-call + tool-result
            {
                type: "tool-call",
                toolCallId: "plan:turn_plan:1",
                toolName: "codex_plan_update",
                input: JSON.stringify({}),
                providerExecuted: true,
                dynamic: true,
            },
            {
                type: "tool-result",
                toolCallId: "plan:turn_plan:1",
                toolName: "codex_plan_update",
                result: {
                    plan: [
                        { step: "Read config", status: "completed" },
                        { step: "Update mapper", status: "in_progress" },
                    ],
                    explanation: "Updating files",
                },
            },
            // Second plan update: new tool-call + tool-result pair
            {
                type: "tool-call",
                toolCallId: "plan:turn_plan:2",
                toolName: "codex_plan_update",
                input: JSON.stringify({}),
                providerExecuted: true,
                dynamic: true,
            },
            {
                type: "tool-result",
                toolCallId: "plan:turn_plan:2",
                toolName: "codex_plan_update",
                result: {
                    plan: [
                        { step: "Read config", status: "completed" },
                        { step: "Update mapper", status: "completed" },
                    ],
                    explanation: "Almost done",
                },
            },
            // codex/event/plan_update wrapper produces nothing.
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("suppresses plan updates when emitPlanUpdates is false", () =>
    {
        const mapper = new CodexEventMapper({ emitPlanUpdates: false });

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn_plan2" } } },
            {
                method: "turn/plan/updated",
                params: {
                    threadId: "thr",
                    turnId: "turn_plan2",
                    explanation: "Planning",
                    plan: [{ step: "Do stuff", status: "in_progress" }],
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn_plan2", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        // No tool-call/tool-result parts — plan updates are suppressed.
        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("ignores codex/event MCP wrapper events", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn_mcp" } } },
            {
                method: "codex/event/mcp_tool_call_begin",
                params: {
                    id: "turn_mcp",
                    msg: {
                        type: "mcp_tool_call_begin",
                        call_id: "call_mcp_1",
                        invocation: {
                            server: "github",
                            tool: "get_file_contents",
                            arguments: { owner: "acme", repo: "test", path: "README.md" },
                        },
                    },
                    conversationId: "thr",
                },
            },
            {
                method: "codex/event/mcp_tool_call_end",
                params: {
                    id: "turn_mcp",
                    msg: {
                        type: "mcp_tool_call_end",
                        call_id: "call_mcp_1",
                        invocation: {
                            server: "github",
                            tool: "get_file_contents",
                            arguments: { owner: "acme", repo: "test", path: "README.md" },
                        },
                        result: {
                            Ok: {
                                content: [
                                    { type: "text", text: "# Test Repo" },
                                ],
                            },
                        },
                    },
                    conversationId: "thr",
                },
            },
            {
                method: "turn/completed",
                params: {
                    threadId: "thr",
                    turn: { id: "turn_mcp", items: [], status: "completed" as const, error: null },
                },
            },
        ];

        const parts = events.flatMap((event) => mapper.map(event));

        expect(parts).toEqual([
            { type: "stream-start", warnings: [] },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("emits file stream part for imageGeneration item", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
            {
                method: "item/started",
                params: {
                    item: {
                        type: "imageGeneration",
                        id: "img_1",
                        status: "inProgress",
                        revisedPrompt: null,
                        result: "",
                    },
                    threadId: "thr",
                    turnId: "turn",
                },
            },
            {
                method: "item/completed",
                params: {
                    item: {
                        type: "imageGeneration",
                        id: "img_1",
                        status: "completed",
                        revisedPrompt: "a beautiful mountain landscape at sunrise",
                        result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
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
                type: "file",
                mediaType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                providerMetadata: {
                    "@janole/ai-sdk-provider-codex-asp": {
                        turnId: "turn",
                        revisedPrompt: "a beautiful mountain landscape at sunrise",
                    },
                },
            },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });

    it("emits file stream part without providerMetadata when revisedPrompt is null", () =>
    {
        const mapper = new CodexEventMapper();

        const events = [
            { method: "turn/started", params: { threadId: "thr", turn: { id: "turn" } } },
            {
                method: "item/completed",
                params: {
                    item: {
                        type: "imageGeneration",
                        id: "img_2",
                        status: "completed",
                        revisedPrompt: null,
                        result: "abc123",
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
                type: "file",
                mediaType: "image/png",
                data: "abc123",
            },
            {
                type: "finish",
                finishReason: { unified: "stop", raw: "completed" },
                usage: EMPTY_USAGE,
            },
        ]);
    });
});
