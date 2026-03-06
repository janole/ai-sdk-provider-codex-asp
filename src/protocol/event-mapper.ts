import type {
    LanguageModelV3FinishReason,
    LanguageModelV3StreamPart,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";

import type { AgentMessageDeltaNotification } from "./app-server-protocol/v2/AgentMessageDeltaNotification";
import type { CommandExecutionOutputDeltaNotification } from "./app-server-protocol/v2/CommandExecutionOutputDeltaNotification";
import type { ItemCompletedNotification } from "./app-server-protocol/v2/ItemCompletedNotification";
import type { ItemStartedNotification } from "./app-server-protocol/v2/ItemStartedNotification";
import type { McpToolCallProgressNotification } from "./app-server-protocol/v2/McpToolCallProgressNotification";
import type { ReasoningSummaryPartAddedNotification } from "./app-server-protocol/v2/ReasoningSummaryPartAddedNotification";
import type { ThreadTokenUsageUpdatedNotification } from "./app-server-protocol/v2/ThreadTokenUsageUpdatedNotification";
import type { TurnCompletedNotification } from "./app-server-protocol/v2/TurnCompletedNotification";
import type { TurnStartedNotification } from "./app-server-protocol/v2/TurnStartedNotification";
import type { TurnStatus } from "./app-server-protocol/v2/TurnStatus";
import { withProviderMetadata } from "./provider-metadata";
import type { CodexDynamicToolCallItem } from "./types";

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
    /**
     * Max retained tool-result output chars; older content is truncated. Default: 32768.
     * Set to 0 or a negative value to disable truncation.
     */
    maxToolResultOutputChars?: number;
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
const DEFAULT_MAX_TOOL_RESULT_OUTPUT_CHARS = 32_768;

export class CodexEventMapper
{
    private readonly options: Required<CodexEventMapperOptions>;
    private streamStarted = false;
    private readonly openTextParts = new Set<string>();
    private readonly textDeltaReceived = new Set<string>();
    private readonly openReasoningParts = new Set<string>();
    private readonly openToolCalls = new Map<string, { toolName: string; output: string; droppedChars: number }>();
    private readonly planSequenceByTurnId = new Map<string, number>();
    private threadId: string | undefined;
    private turnId: string | undefined;
    private latestUsage: LanguageModelV3Usage | undefined;

    private readonly handlers: Record<string, (params: unknown) => LanguageModelV3StreamPart[]>;

    constructor(options?: CodexEventMapperOptions)
    {
        this.options = {
            emitPlanUpdates: options?.emitPlanUpdates ?? true,
            maxToolResultOutputChars: options?.maxToolResultOutputChars ?? DEFAULT_MAX_TOOL_RESULT_OUTPUT_CHARS,
        };

        this.handlers = {
            "turn/started": (p) => this.handleTurnStarted(p),
            "item/started": (p) => this.handleItemStarted(p),
            "item/agentMessage/delta": (p) => this.handleAgentMessageDelta(p),
            "item/completed": (p) => this.handleItemCompleted(p),
            "item/reasoning/textDelta": (p) => this.handleReasoningDelta(p),
            "item/reasoning/summaryTextDelta": (p) => this.handleReasoningDelta(p),
            "item/plan/delta": (p) => this.handleReasoningDelta(p),
            "item/fileChange/outputDelta": (p) => this.handleReasoningDelta(p),
            "item/reasoning/summaryPartAdded": (p) => this.handleSummaryPartAdded(p),
            "turn/plan/updated": (p) => this.handlePlanUpdated(p),
            "item/commandExecution/outputDelta": (p) => this.handleCommandOutputDelta(p),
            "codex/event/mcp_tool_call_begin": (p) => this.handleMcpToolCallBegin(p),
            "codex/event/mcp_tool_call_end": (p) => this.handleMcpToolCallEnd(p),
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
            // Intentionally ignored: web search wrappers mirror item events.
            // We emit web-search reasoning only from item/started + item/completed.
            "codex/event/web_search_begin": NOOP,
            "codex/event/web_search_end": NOOP,

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

    private applyOutputLimit(output: string): { output: string; droppedChars: number }
    {
        const limit = this.options.maxToolResultOutputChars;
        if (limit <= 0)
        {
            return { output, droppedChars: 0 };
        }

        if (output.length <= limit)
        {
            return { output, droppedChars: 0 };
        }

        const droppedChars = output.length - limit;
        return { output: output.slice(droppedChars), droppedChars };
    }

    private appendTrackedOutput(tracked: { output: string; droppedChars: number }, delta: string): void
    {
        if (!delta)
        {
            return;
        }

        const combined = tracked.output + delta;
        const limited = this.applyOutputLimit(combined);
        tracked.output = limited.output;
        tracked.droppedChars += limited.droppedChars;
    }

    private formatToolOutput(output: string, droppedChars: number): string
    {
        if (droppedChars <= 0)
        {
            return output;
        }

        return `[output truncated: ${droppedChars} chars omitted]\n${output}`;
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
                this.openToolCalls.set(item.id, { toolName, output: "", droppedChars: 0 });
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
            case "reasoning":
            case "plan":
            case "fileChange":
            case "mcpToolCall":
            case "collabAgentToolCall":
            case "webSearch":
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
        else if (item.type === "commandExecution" && this.openToolCalls.has(item.id))
        {
            const tracked = this.openToolCalls.get(item.id)!;
            const outputSource = item.aggregatedOutput ?? tracked.output;
            const limitedOutput = this.applyOutputLimit(outputSource);
            const output = this.formatToolOutput(
                limitedOutput.output,
                item.aggregatedOutput !== undefined && item.aggregatedOutput !== null
                    ? limitedOutput.droppedChars
                    : tracked.droppedChars,
            );
            const exitCode = item.exitCode;
            const status = item.status;

            parts.push(this.withMeta({
                type: "tool-result",
                toolCallId: item.id,
                toolName: tracked.toolName,
                result: { output, exitCode, status },
            }));
            this.openToolCalls.delete(item.id);
        }
        else if (item.type === "dynamicToolCall")
        {
            const dynamic = item;
            const tracked = this.openToolCalls.get(item.id);
            const toolName = tracked?.toolName ?? dynamic.tool ?? "dynamic_tool_call";
            const rawOutput = this.stringifyDynamicToolResult(dynamic);
            const limitedOutput = this.applyOutputLimit(rawOutput);
            parts.push(this.withMeta({
                type: "tool-result",
                toolCallId: item.id,
                toolName,
                result: {
                    output: this.formatToolOutput(limitedOutput.output, limitedOutput.droppedChars),
                    success: dynamic.success ?? undefined,
                },
            }));
            this.openToolCalls.delete(item.id);
        }
        else if (item.type === "webSearch")
        {
            const webSearchSummary = this.formatWebSearchItemSummary(item as {
                query?: string;
                action?: { type?: string; query?: string | null; url?: string | null; pattern?: string | null };
            });
            if (webSearchSummary)
            {
                this.emitReasoningDelta(parts, item.id, webSearchSummary);
            }

            if (this.openReasoningParts.has(item.id))
            {
                parts.push(this.withMeta({ type: "reasoning-end", id: item.id }));
                this.openReasoningParts.delete(item.id);
            }
        }
        else if (this.openReasoningParts.has(item.id))
        {
            parts.push(this.withMeta({ type: "reasoning-end", id: item.id }));
            this.openReasoningParts.delete(item.id);
        }

        return parts;
    }

    // item/reasoning/textDelta, item/reasoning/summaryTextDelta, item/plan/delta, item/fileChange/outputDelta
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

    // item/commandExecution/outputDelta
    private handleCommandOutputDelta(params: unknown): LanguageModelV3StreamPart[]
    {
        const delta = (params ?? {}) as CommandExecutionOutputDeltaNotification;
        if (!delta.itemId || !delta.delta || !this.openToolCalls.has(delta.itemId))
        {
            return [];
        }

        const tracked = this.openToolCalls.get(delta.itemId)!;
        this.appendTrackedOutput(tracked, delta.delta);
        return [this.withMeta({
            type: "tool-result",
            toolCallId: delta.itemId,
            toolName: tracked.toolName,
            result: { output: this.formatToolOutput(tracked.output, tracked.droppedChars) },
            preliminary: true,
        })];
    }

    // codex/event/mcp_tool_call_begin
    private handleMcpToolCallBegin(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as {
            msg?: {
                call_id?: string;
                invocation?: { server?: string; tool?: string; arguments?: unknown };
            };
        };
        const callId = p.msg?.call_id;
        const inv = p.msg?.invocation;
        if (!callId || !inv)
        {
            return [];
        }

        const parts: LanguageModelV3StreamPart[] = [];
        this.ensureStreamStarted(parts);
        const toolName = `mcp:${inv.server}/${inv.tool}`;
        this.openToolCalls.set(callId, { toolName, output: "", droppedChars: 0 });
        parts.push(this.withMeta({
            type: "tool-call",
            toolCallId: callId,
            toolName,
            input: JSON.stringify(inv.arguments ?? {}),
            providerExecuted: true,
            dynamic: true,
        }));
        return parts;
    }

    // codex/event/mcp_tool_call_end
    private handleMcpToolCallEnd(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as {
            msg?: {
                call_id?: string;
                result?: { Ok?: { content?: Array<{ type: string; text?: string }> }; Err?: unknown };
            };
        };
        const callId = p.msg?.call_id;
        if (!callId || !this.openToolCalls.has(callId))
        {
            return [];
        }

        const tracked = this.openToolCalls.get(callId)!;
        const result = p.msg?.result;
        const textParts = result?.Ok?.content?.filter(c => c.type === "text").map(c => c.text) ?? [];
        const rawOutput = textParts.join("\n") || (result?.Err ? JSON.stringify(result.Err) : "");
        const limitedOutput = this.applyOutputLimit(rawOutput);

        this.openToolCalls.delete(callId);
        return [this.withMeta({
            type: "tool-result",
            toolCallId: callId,
            toolName: tracked.toolName,
            result: { output: this.formatToolOutput(limitedOutput.output, limitedOutput.droppedChars) },
        })];
    }

    // item/mcpToolCall/progress
    private handleMcpToolCallProgress(params: unknown): LanguageModelV3StreamPart[]
    {
        const p = (params ?? {}) as McpToolCallProgressNotification;
        if (!p.itemId || !p.message)
        {
            return [];
        }
        const parts: LanguageModelV3StreamPart[] = [];
        this.emitReasoningDelta(parts, p.itemId, p.message);
        return parts;
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

        this.openToolCalls.set(item.id, { toolName: item.tool, output: "", droppedChars: 0 });
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

    private stringifyDynamicToolResult(item: Pick<DynamicToolCallItem, "contentItems">): string
    {
        const contentItems = item.contentItems ?? [];
        if (!contentItems.length)
        {
            return "";
        }

        const chunks: string[] = [];
        for (const contentItem of contentItems)
        {
            if (contentItem.type === "inputText" && contentItem.text)
            {
                chunks.push(contentItem.text);
                continue;
            }

            if (contentItem.type === "inputImage" && contentItem.imageUrl)
            {
                chunks.push(`[image] ${contentItem.imageUrl}`);
            }
        }
        return chunks.join("\n");
    }

    private formatWebSearchItemSummary(item: {
        query?: string;
        action?: { type?: string; query?: string | null; url?: string | null; pattern?: string | null };
    }): string
    {
        const query = item.query?.trim();
        const actionType = item.action?.type;

        if (actionType === "search")
        {
            if (query)
            {
                return `Web search: ${query}`;
            }
            const actionQuery = item.action?.query?.trim();
            return actionQuery ? `Web search: ${actionQuery}` : "Web search";
        }

        if (actionType === "openPage" || actionType === "open_page")
        {
            const url = item.action?.url?.trim();
            return url ? `Open page: ${url}` : "Open page";
        }

        if (actionType === "findInPage" || actionType === "find_in_page")
        {
            const pattern = item.action?.pattern?.trim();
            const url = item.action?.url?.trim();
            if (pattern && url)
            {
                return `Find in page: "${pattern}" (${url})`;
            }
            if (pattern)
            {
                return `Find in page: "${pattern}"`;
            }
            return url ? `Find in page: ${url}` : "Find in page";
        }

        return query ? `Web search: ${query}` : "";
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
