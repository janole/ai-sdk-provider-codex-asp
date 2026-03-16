import type {
    LanguageModelV3FinishReason,
    LanguageModelV3StreamPart,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";

import type { AgentMessageDeltaNotification } from "./app-server-protocol/v2/AgentMessageDeltaNotification";
import type { ItemCompletedNotification } from "./app-server-protocol/v2/ItemCompletedNotification";
import type { ItemStartedNotification } from "./app-server-protocol/v2/ItemStartedNotification";
import type { McpToolCallProgressNotification } from "./app-server-protocol/v2/McpToolCallProgressNotification";
import type { ReasoningSummaryPartAddedNotification } from "./app-server-protocol/v2/ReasoningSummaryPartAddedNotification";
import type { ThreadItem } from "./app-server-protocol/v2/ThreadItem";
import type { ThreadTokenUsageUpdatedNotification } from "./app-server-protocol/v2/ThreadTokenUsageUpdatedNotification";
import type { TurnCompletedNotification } from "./app-server-protocol/v2/TurnCompletedNotification";
import type { TurnStartedNotification } from "./app-server-protocol/v2/TurnStartedNotification";
import type { TurnStatus } from "./app-server-protocol/v2/TurnStatus";
import { withProviderMetadata } from "./provider-metadata";
import type { CodexDynamicToolCallItem } from "./types";

const NATIVE_TOOL_RESULT_TYPES: Set<ThreadItem["type"]> = new Set(["commandExecution", "dynamicToolCall", "fileChange", "mcpToolCall", "webSearch"]);

export interface CodexEventMapperInput
{
    method: string;
    params?: unknown;
}

/** Shared shape for reasoning/plan/fileChange delta params. */
interface DeltaParams
{
    itemId?: string;
    delta?: string;
}

type DynamicToolCallItem = CodexDynamicToolCallItem;

const EMPTY_USAGE: LanguageModelV3Usage = {
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

function toFinishReason(status: TurnStatus | undefined): LanguageModelV3FinishReason
{
    switch (status)
    {
        case "completed":
            return { unified: "stop", raw: "completed" };
        case "failed":
            return { unified: "error", raw: "failed" };
        case "interrupted":
            return { unified: "other", raw: "interrupted" };
        default:
            return { unified: "other", raw: undefined };
    }
}

export interface CodexEventMapperOptions
{
    /** Emit plan updates as tool-call/tool-result parts. Default: true. */
    emitPlanUpdates?: boolean;
}

/**
 * Extract threadId from notification params. All codex protocol notifications
 * include threadId as a top-level field. Returns undefined for notifications
 * that don't carry a threadId (e.g. codex/event/* wrappers, account events).
 */
export function extractNotificationThreadId(params: unknown): string | undefined
{
    if (params && typeof params === "object" && "threadId" in params)
    {
        const val = (params as Record<string, unknown>)["threadId"];
        return typeof val === "string" ? val : undefined;
    }
    return undefined;
}

// No-op handler for intentionally ignored events.
const NOOP = (): LanguageModelV3StreamPart[] => [];
export class CodexEventMapper
{
    private readonly options: Required<CodexEventMapperOptions>;
    private streamStarted = false;
    private readonly openTextParts = new Set<string>();
    private readonly textDeltaReceived = new Set<string>();
    private readonly openReasoningParts = new Set<string>();
    private readonly openToolCalls = new Map<string, { toolName: string }>();
    private readonly planSequenceByTurnId = new Map<string, number>();
    private threadId: string | undefined;
    private turnId: string | undefined;
    private latestUsage: LanguageModelV3Usage | undefined;

    private readonly handlers: Record<string, (params: unknown) => LanguageModelV3StreamPart[]>;

    constructor(options?: CodexEventMapperOptions)
    {
        this.options = {
            emitPlanUpdates: options?.emitPlanUpdates ?? true,
        };

        this.handlers = {
            "turn/started": (p) => this.handleTurnStarted(p),
            "item/started": (p) => this.handleItemStarted(p),
            "item/agentMessage/delta": (p) => this.handleAgentMessageDelta(p),
            "item/completed": (p) => this.handleItemCompleted(p),
            "item/reasoning/textDelta": (p) => this.handleReasoningDelta(p),
            "item/reasoning/summaryTextDelta": (p) => this.handleReasoningDelta(p),
            "item/plan/delta": (p) => this.handleReasoningDelta(p),
            "item/reasoning/summaryPartAdded": (p) => this.handleSummaryPartAdded(p),
            "turn/plan/updated": (p) => this.handlePlanUpdated(p),
            "item/mcpToolCall/progress": (p) => this.handleMcpToolCallProgress(p),
            "item/tool/callStarted": (p) => this.handleToolCallStarted(p),
            "item/tool/callDelta": (p) => this.handleToolCallDelta(p),
            "item/tool/callFinished": (p) => this.handleToolCallFinished(p),
            "item/tool/call": (p) => this.handleToolCall(p),
            "thread/tokenUsage/updated": (p) => this.handleTokenUsageUpdated(p),
            "turn/completed": (p) => this.handleTurnCompleted(p),

            // Intentionally ignored: wrapper/duplicate events handled by their canonical forms above.
            "codex/event/agent_reasoning": NOOP,
            "codex/event/agent_reasoning_section_break": NOOP,
            "codex/event/plan_update": NOOP,
            // Intentionally ignored: web search and MCP wrappers mirror item events.
            "codex/event/web_search_begin": NOOP,
            "codex/event/web_search_end": NOOP,
            "codex/event/mcp_tool_call_begin": NOOP,
            "codex/event/mcp_tool_call_end": NOOP,

            // Intentionally ignored: streaming output deltas — the full output arrives
            // in item/completed (aggregatedOutput), making these redundant.
            "item/commandExecution/outputDelta": NOOP,
            "item/fileChange/outputDelta": NOOP,

            // Intentionally ignored: full diffs (often 50-100 KB) crash/freeze frontend renderers.
            // If these need to surface, they should use a dedicated part type with lazy rendering.
            "turn/diff/updated": NOOP,
            "codex/event/turn_diff": NOOP,
        };
    }

    setThreadId(threadId: string): void
    {
        this.threadId = threadId;
    }

    setTurnId(turnId: string): void
    {
        this.turnId = turnId;
    }

    getTurnId(): string | undefined
    {
        return this.turnId;
    }

    map(event: CodexEventMapperInput): LanguageModelV3StreamPart[]
    {
        const handler = this.handlers[event.method];
        return handler ? handler(event.params) : [];
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private withMeta<T extends LanguageModelV3StreamPart>(part: T): T
    {
        return withProviderMetadata(part, this.threadId, this.turnId);
    }

    private ensureStreamStarted(parts: LanguageModelV3StreamPart[]): void
    {
        if (!this.streamStarted)
        {
            parts.push({ type: "stream-start", warnings: [] });
            this.streamStarted = true;
        }
    }

    private emitReasoningDelta(parts: LanguageModelV3StreamPart[], id: string, delta: string): void
    {
        this.ensureStreamStarted(parts);

        if (!this.openReasoningParts.has(id))
        {
            this.openReasoningParts.add(id);
            parts.push(this.withMeta({ type: "reasoning-start", id }));
        }

        if (delta)
        {
            parts.push(this.withMeta({ type: "reasoning-delta", id, delta }));
        }
    }

    private nextPlanSequence(turnId: string): number
    {
        const next = (this.planSequenceByTurnId.get(turnId) ?? 0) + 1;
        this.planSequenceByTurnId.set(turnId, next);
        return next;
    }

    // ── Handlers ─────────────────────────────────────────────────────────────

    // turn/started
    private handleTurnStarted(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = params as TurnStartedNotification | undefined;
        if (p?.turn?.id)
        {
            this.turnId = p.turn.id;
        }
        const parts: LanguageModelV3StreamPart[] = [];
        this.ensureStreamStarted(parts);
        return parts;
    }

    // item/started
    private handleItemStarted(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as ItemStartedNotification;
        const item = p.item;
        if (!item?.id)
        {
            return [];
        }

        const parts: LanguageModelV3StreamPart[] = [];

        switch (item.type)
        {
            case "agentMessage": {
                this.ensureStreamStarted(parts);
                this.openTextParts.add(item.id);
                parts.push(this.withMeta({ type: "text-start", id: item.id }));
                break;
            }
            case "commandExecution": {
                this.ensureStreamStarted(parts);
                const toolName = "codex_command_execution";
                this.openToolCalls.set(item.id, { toolName });
                parts.push(this.withMeta({
                    type: "tool-call",
                    toolCallId: item.id,
                    toolName,
                    input: JSON.stringify({ command: item.command, cwd: item.cwd }),
                    providerExecuted: true,
                    dynamic: true,
                }));
                break;
            }
            case "dynamicToolCall": {
                parts.push(...this.startDynamicToolCall(item));
                break;
            }
            case "fileChange": {
                this.ensureStreamStarted(parts);
                const toolName = "codex_file_change";
                this.openToolCalls.set(item.id, { toolName });
                parts.push(this.withMeta({
                    type: "tool-call",
                    toolCallId: item.id,
                    toolName,
                    input: JSON.stringify({ changes: item.changes, status: item.status }),
                    providerExecuted: true,
                    dynamic: true,
                }));
                break;
            }
            case "webSearch": {
                this.ensureStreamStarted(parts);
                const toolName = "codex_web_search";
                this.openToolCalls.set(item.id, { toolName });
                parts.push(this.withMeta({
                    type: "tool-call",
                    toolCallId: item.id,
                    toolName,
                    input: JSON.stringify({ query: item.query, action: item.action ?? undefined }),
                    providerExecuted: true,
                    dynamic: true,
                }));
                break;
            }
            case "mcpToolCall": {
                this.ensureStreamStarted(parts);
                const toolName = `mcp:${item.server}/${item.tool}`;
                this.openToolCalls.set(item.id, { toolName });
                parts.push(this.withMeta({
                    type: "tool-call",
                    toolCallId: item.id,
                    toolName,
                    input: JSON.stringify(item.arguments ?? {}),
                    providerExecuted: true,
                    dynamic: true,
                }));
                break;
            }
            case "reasoning":
            case "plan":
            case "collabAgentToolCall":
            case "imageView":
            case "contextCompaction":
            case "enteredReviewMode":
            case "exitedReviewMode": {
                this.emitReasoningDelta(parts, item.id, "");
                break;
            }
            default:
                break;
        }

        return parts;
    }

    // item/agentMessage/delta
    private handleAgentMessageDelta(params: unknown): LanguageModelV3StreamPart[]
    {
        const delta = (params ?? {}) as AgentMessageDeltaNotification;
        if (!delta.itemId || !delta.delta)
        {
            return [];
        }

        const parts: LanguageModelV3StreamPart[] = [];
        this.ensureStreamStarted(parts);

        if (!this.openTextParts.has(delta.itemId))
        {
            this.openTextParts.add(delta.itemId);
            parts.push(this.withMeta({ type: "text-start", id: delta.itemId }));
        }

        parts.push(this.withMeta({ type: "text-delta", id: delta.itemId, delta: delta.delta }));
        this.textDeltaReceived.add(delta.itemId);
        return parts;
    }

    // item/completed
    private handleItemCompleted(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as ItemCompletedNotification;
        const item = p.item;
        if (!item?.id)
        {
            return [];
        }

        const parts: LanguageModelV3StreamPart[] = [];

        if (item.type === "agentMessage")
        {
            if (!this.textDeltaReceived.has(item.id) && item.text)
            {
                this.ensureStreamStarted(parts);

                if (!this.openTextParts.has(item.id))
                {
                    this.openTextParts.add(item.id);
                    parts.push(this.withMeta({ type: "text-start", id: item.id }));
                }

                parts.push(this.withMeta({ type: "text-delta", id: item.id, delta: item.text }));
            }

            if (this.openTextParts.has(item.id))
            {
                parts.push(this.withMeta({ type: "text-end", id: item.id }));
                this.openTextParts.delete(item.id);
            }
        }
        else if (NATIVE_TOOL_RESULT_TYPES.has(item.type) && this.openToolCalls.has(item.id))
        {
            const tracked = this.openToolCalls.get(item.id)!;

            parts.push(this.withMeta({
                type: "tool-result",
                toolCallId: item.id,
                toolName: tracked.toolName,
                result: { item },
            }));

            this.openToolCalls.delete(item.id);
        }
        else if (this.openReasoningParts.has(item.id))
        {
            parts.push(this.withMeta({ type: "reasoning-end", id: item.id }));
            this.openReasoningParts.delete(item.id);
        }

        return parts;
    }

    // item/reasoning/textDelta, item/reasoning/summaryTextDelta, item/plan/delta
    private handleReasoningDelta(params: unknown): LanguageModelV3StreamPart[]
    {
        const delta = (params ?? {}) as DeltaParams;
        if (!delta.itemId || !delta.delta)
        {
            return [];
        }
        const parts: LanguageModelV3StreamPart[] = [];
        this.emitReasoningDelta(parts, delta.itemId, delta.delta);
        return parts;
    }

    // item/reasoning/summaryPartAdded
    private handleSummaryPartAdded(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as ReasoningSummaryPartAddedNotification;
        if (!p.itemId)
        {
            return [];
        }
        const parts: LanguageModelV3StreamPart[] = [];
        this.emitReasoningDelta(parts, p.itemId, "\n\n");
        return parts;
    }

    // turn/plan/updated
    private handlePlanUpdated(params: unknown): LanguageModelV3StreamPart[]
    {
        if (!this.options.emitPlanUpdates)
        {
            return [];
        }

        const p = (params ?? {}) as {
            turnId?: string;
            explanation?: string | null;
            plan?: Array<{ step: string; status: string }>;
        };
        const turnId = p.turnId;
        const plan = p.plan;
        if (!turnId || !plan)
        {
            return [];
        }

        const parts: LanguageModelV3StreamPart[] = [];
        this.ensureStreamStarted(parts);
        const planSequence = this.nextPlanSequence(turnId);
        const toolCallId = `plan:${turnId}:${planSequence}`;
        const toolName = "codex_plan_update";

        parts.push(this.withMeta({
            type: "tool-call",
            toolCallId,
            toolName,
            input: JSON.stringify({}),
            providerExecuted: true,
            dynamic: true,
        }));

        parts.push(this.withMeta({
            type: "tool-result",
            toolCallId,
            toolName,
            result: { plan, explanation: p.explanation ?? undefined },
        }));

        return parts;
    }

    // item/mcpToolCall/progress
    private handleMcpToolCallProgress(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as McpToolCallProgressNotification;
        if (!p.itemId || !p.message)
        {
            return [];
        }
        const tracked = this.openToolCalls.get(p.itemId);
        if (!tracked)
        {
            return [];
        }
        // preliminary: true causes the AI SDK to replace the previous tool-result
        // with this one, so each progress message overwrites the last rather than
        // accumulating. p.message is just the current status (e.g. "Searching...").
        return [this.withMeta({
            type: "tool-result",
            toolCallId: p.itemId,
            toolName: tracked.toolName,
            result: { output: p.message },
            preliminary: true,
        })];
    }

    // item/tool/callStarted
    private handleToolCallStarted(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as { callId?: string; tool?: string };
        if (!p.callId || !p.tool)
        {
            return [];
        }
        const parts: LanguageModelV3StreamPart[] = [];
        this.ensureStreamStarted(parts);
        parts.push(this.withMeta({ type: "tool-input-start", id: p.callId, toolName: p.tool, dynamic: true }));
        return parts;
    }

    // item/tool/callDelta
    private handleToolCallDelta(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as { callId?: string; delta?: string };
        if (!p.callId || !p.delta)
        {
            return [];
        }
        return [this.withMeta({ type: "tool-input-delta", id: p.callId, delta: p.delta })];
    }

    // item/tool/callFinished
    private handleToolCallFinished(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as { callId?: string };
        if (!p.callId)
        {
            return [];
        }
        return [this.withMeta({ type: "tool-input-end", id: p.callId })];
    }

    // item/tool/call
    private handleToolCall(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as { callId?: string; tool?: string; arguments?: unknown };
        if (!p.callId || !p.tool)
        {
            return [];
        }
        return this.startDynamicToolCall({
            id: p.callId,
            tool: p.tool,
            arguments: p.arguments ?? {},
        });
    }

    private startDynamicToolCall(item: Pick<DynamicToolCallItem, "id" | "tool" | "arguments">): LanguageModelV3StreamPart[]
    {
        if (!item.id || !item.tool)
        {
            return [];
        }

        if (this.openToolCalls.has(item.id))
        {
            return [];
        }

        const parts: LanguageModelV3StreamPart[] = [];
        this.ensureStreamStarted(parts);

        this.openToolCalls.set(item.id, { toolName: item.tool });
        parts.push(this.withMeta({
            type: "tool-call",
            toolCallId: item.id,
            toolName: item.tool,
            input: JSON.stringify(item.arguments ?? {}),
            providerExecuted: true,
            dynamic: true,
        }));

        return parts;
    }

    // thread/tokenUsage/updated
    private handleTokenUsageUpdated(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as ThreadTokenUsageUpdatedNotification;
        const last = p.tokenUsage?.last;
        if (last)
        {
            this.latestUsage = {
                inputTokens: {
                    total: last.inputTokens,
                    noCache: undefined,
                    cacheRead: last.cachedInputTokens,
                    cacheWrite: undefined,
                },
                outputTokens: {
                    total: last.outputTokens,
                    text: undefined,
                    reasoning: last.reasoningOutputTokens,
                },
            };
        }
        return [];
    }

    // turn/completed
    private handleTurnCompleted(params: unknown): LanguageModelV3StreamPart[]
    {
        const parts: LanguageModelV3StreamPart[] = [];
        this.ensureStreamStarted(parts);

        for (const itemId of this.openTextParts)
        {
            parts.push(this.withMeta({ type: "text-end", id: itemId }));
        }
        this.openTextParts.clear();

        for (const itemId of this.openReasoningParts)
        {
            parts.push(this.withMeta({ type: "reasoning-end", id: itemId }));
        }
        this.openReasoningParts.clear();

        for (const [itemId, tracked] of this.openToolCalls)
        {
            parts.push(this.withMeta({
                type: "tool-result",
                toolCallId: itemId,
                toolName: tracked.toolName,
                result: { output: this.formatToolOutput(tracked.output, tracked.droppedChars) },
            }));
        }
        this.openToolCalls.clear();

        const completed = (params ?? {}) as TurnCompletedNotification;
        if (completed.turn?.id)
        {
            this.planSequenceByTurnId.delete(completed.turn.id);
        }
        const usage = this.latestUsage ?? EMPTY_USAGE;
        parts.push(this.withMeta({ type: "finish", finishReason: toFinishReason(completed.turn?.status), usage }));
        return parts;
    }
}
