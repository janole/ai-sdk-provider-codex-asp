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
    private readonly openToolCalls = new Map<string, { toolName: string; output: string }>();
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
            "thread/tokenUsage/updated": (p) => this.handleTokenUsageUpdated(p),
            "turn/completed": (p) => this.handleTurnCompleted(p),

            // Intentionally ignored: wrapper/duplicate events handled by their canonical forms above.
            "codex/event/agent_reasoning": NOOP,
            "codex/event/agent_reasoning_section_break": NOOP,
            "codex/event/plan_update": NOOP,

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
                this.openToolCalls.set(item.id, { toolName, output: "" });
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
            const output = item.aggregatedOutput ?? tracked.output;
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
        tracked.output += delta.delta;
        return [this.withMeta({
            type: "tool-result",
            toolCallId: delta.itemId,
            toolName: tracked.toolName,
            result: { output: tracked.output },
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
        this.openToolCalls.set(callId, { toolName, output: "" });
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
        const output = textParts.join("\n") || (result?.Err ? JSON.stringify(result.Err) : "");

        this.openToolCalls.delete(callId);
        return [this.withMeta({
            type: "tool-result",
            toolCallId: callId,
            toolName: tracked.toolName,
            result: { output },
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
                result: { output: tracked.output },
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
