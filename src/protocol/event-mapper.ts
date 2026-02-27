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
    private latestUsage: LanguageModelV3Usage | undefined;

    constructor(options?: CodexEventMapperOptions)
    {
        this.options = {
            emitPlanUpdates: options?.emitPlanUpdates ?? true,
        };
    }

    setThreadId(threadId: string): void
    {
        this.threadId = threadId;
    }

    private nextPlanSequence(turnId: string): number
    {
        const next = (this.planSequenceByTurnId.get(turnId) ?? 0) + 1;
        this.planSequenceByTurnId.set(turnId, next);
        return next;
    }

    map(event: CodexEventMapperInput): LanguageModelV3StreamPart[]
    {
        const parts: LanguageModelV3StreamPart[] = [];

        const withMeta = <T extends LanguageModelV3StreamPart>(part: T): T =>
            withProviderMetadata(part, this.threadId);

        const pushStreamStart = () =>
        {
            if (!this.streamStarted)
            {
                parts.push({ type: "stream-start", warnings: [] });
                this.streamStarted = true;
            }
        };

        const pushReasoningDelta = (id: string, delta: string) =>
        {
            pushStreamStart();

            if (!this.openReasoningParts.has(id))
            {
                this.openReasoningParts.add(id);
                parts.push(withMeta({ type: "reasoning-start", id }));
            }

            if (!delta)
            {
                return;
            }

            parts.push(withMeta({ type: "reasoning-delta", id, delta }));
        };

        switch (event.method)
        {
            case "turn/started": {
                pushStreamStart();
                break;
            }

            case "item/started": {
                const params = (event.params ?? {}) as ItemStartedNotification;
                const item = params.item;
                if (!item?.id)
                {
                    break;
                }

                switch (item.type)
                {
                    case "agentMessage": {
                        pushStreamStart();
                        this.openTextParts.add(item.id);
                        parts.push(withMeta({ type: "text-start", id: item.id }));
                        break;
                    }
                    case "commandExecution": {
                        pushStreamStart();
                        const toolName = "codex_command_execution";
                        this.openToolCalls.set(item.id, { toolName, output: "" });
                        parts.push(withMeta({
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
                        pushReasoningDelta(item.id, "");
                        break;
                    }
                    default:
                        break;
                }
                break;
            }

            case "item/agentMessage/delta": {
                const delta = (event.params ?? {}) as AgentMessageDeltaNotification;
                if (!delta.itemId || !delta.delta)
                {
                    break;
                }

                pushStreamStart();

                if (!this.openTextParts.has(delta.itemId))
                {
                    this.openTextParts.add(delta.itemId);
                    parts.push(withMeta({ type: "text-start", id: delta.itemId }));
                }

                parts.push(withMeta({ type: "text-delta", id: delta.itemId, delta: delta.delta }));
                this.textDeltaReceived.add(delta.itemId);
                break;
            }

            case "item/completed": {
                const params = (event.params ?? {}) as ItemCompletedNotification;
                const item = params.item;
                if (!item?.id)
                {
                    break;
                }

                if (item.type === "agentMessage")
                {
                    // Fallback: if no deltas were streamed for this item,
                    // emit the full text from the completed event so the
                    // message isn't silently lost.
                    if (!this.textDeltaReceived.has(item.id) && item.text)
                    {
                        pushStreamStart();

                        if (!this.openTextParts.has(item.id))
                        {
                            this.openTextParts.add(item.id);
                            parts.push(withMeta({ type: "text-start", id: item.id }));
                        }

                        parts.push(withMeta({ type: "text-delta", id: item.id, delta: item.text }));
                    }

                    if (this.openTextParts.has(item.id))
                    {
                        parts.push(withMeta({ type: "text-end", id: item.id }));
                        this.openTextParts.delete(item.id);
                    }
                }
                else if (item.type === "commandExecution" && this.openToolCalls.has(item.id))
                {
                    const tracked = this.openToolCalls.get(item.id)!;
                    const output = item.aggregatedOutput ?? tracked.output;
                    const exitCode = item.exitCode;
                    const status = item.status;

                    parts.push(withMeta({
                        type: "tool-result",
                        toolCallId: item.id,
                        toolName: tracked.toolName,
                        result: { output, exitCode, status },
                    }));
                    this.openToolCalls.delete(item.id);
                }
                else if (this.openReasoningParts.has(item.id))
                {
                    parts.push(withMeta({ type: "reasoning-end", id: item.id }));
                    this.openReasoningParts.delete(item.id);
                }
                break;
            }

            case "item/reasoning/textDelta":
            case "item/reasoning/summaryTextDelta":
            case "item/plan/delta":
            case "item/fileChange/outputDelta": {
                const delta = (event.params ?? {}) as DeltaParams;
                if (delta.itemId && delta.delta)
                {
                    pushReasoningDelta(delta.itemId, delta.delta);
                }
                break;
            }

            case "item/reasoning/summaryPartAdded": {
                const params = (event.params ?? {}) as ReasoningSummaryPartAddedNotification;
                if (params.itemId)
                {
                    pushReasoningDelta(params.itemId, "\n\n");
                }
                break;
            }

            // codex/event/agent_reasoning_section_break is the wrapper form of
            // item/reasoning/summaryPartAdded (identical 1:1). Handled by the
            // canonical event above — skip the wrapper to avoid double "\n\n".
            case "codex/event/agent_reasoning_section_break":
                break;

            case "turn/plan/updated": {
                if (!this.options.emitPlanUpdates)
                {
                    break;
                }

                const params = (event.params ?? {}) as {
                    turnId?: string;
                    explanation?: string | null;
                    plan?: Array<{ step: string; status: string }>;
                };
                const turnId = params.turnId;
                const plan = params.plan;
                if (turnId && plan)
                {
                    pushStreamStart();
                    const planSequence = this.nextPlanSequence(turnId);
                    const toolCallId = `plan:${turnId}:${planSequence}`;
                    const toolName = "codex_plan_update";

                    parts.push(withMeta({
                        type: "tool-call",
                        toolCallId,
                        toolName,
                        input: JSON.stringify({}),
                        providerExecuted: true,
                        dynamic: true,
                    }));

                    parts.push(withMeta({
                        type: "tool-result",
                        toolCallId,
                        toolName,
                        result: { plan, explanation: params.explanation ?? undefined },
                    }));
                }
                break;
            }

            // codex/event/plan_update is the wrapper form of turn/plan/updated (1:1).
            case "codex/event/plan_update":
                break;

            // NOTE: turn/diff/updated and codex/event/turn_diff are intentionally
            // NOT mapped. They carry full unified diffs (often 50-100 KB) which,
            // when emitted as reasoning deltas, crash or freeze the frontend
            // markdown renderer. If these need to surface in the UI, they should
            // use a dedicated part type with lazy/collapsed rendering — not
            // reasoning text.
            case "turn/diff/updated":
            case "codex/event/turn_diff":
                break;

            case "item/commandExecution/outputDelta": {
                const delta = (event.params ?? {}) as CommandExecutionOutputDeltaNotification;
                if (delta.itemId && delta.delta && this.openToolCalls.has(delta.itemId))
                {
                    const tracked = this.openToolCalls.get(delta.itemId)!;
                    tracked.output += delta.delta;
                    parts.push(withMeta({
                        type: "tool-result",
                        toolCallId: delta.itemId,
                        toolName: tracked.toolName,
                        result: { output: tracked.output },
                        preliminary: true,
                    }));
                }
                break;
            }

            case "codex/event/mcp_tool_call_begin": {
                const params = (event.params ?? {}) as {
                    msg?: {
                        call_id?: string;
                        invocation?: { server?: string; tool?: string; arguments?: unknown };
                    };
                };
                const callId = params.msg?.call_id;
                const inv = params.msg?.invocation;
                if (callId && inv)
                {
                    pushStreamStart();
                    const toolName = `mcp:${inv.server}/${inv.tool}`;
                    this.openToolCalls.set(callId, { toolName, output: "" });
                    parts.push(withMeta({
                        type: "tool-call",
                        toolCallId: callId,
                        toolName,
                        input: JSON.stringify(inv.arguments ?? {}),
                        providerExecuted: true,
                        dynamic: true,
                    }));
                }
                break;
            }

            case "codex/event/mcp_tool_call_end": {
                const params = (event.params ?? {}) as {
                    msg?: {
                        call_id?: string;
                        result?: { Ok?: { content?: Array<{ type: string; text?: string }> }; Err?: unknown };
                    };
                };
                const callId = params.msg?.call_id;
                if (callId && this.openToolCalls.has(callId))
                {
                    const tracked = this.openToolCalls.get(callId)!;
                    const result = params.msg?.result;
                    const textParts = result?.Ok?.content?.filter(c => c.type === "text").map(c => c.text) ?? [];
                    const output = textParts.join("\n") || (result?.Err ? JSON.stringify(result.Err) : "");

                    parts.push(withMeta({
                        type: "tool-result",
                        toolCallId: callId,
                        toolName: tracked.toolName,
                        result: { output },
                    }));
                    this.openToolCalls.delete(callId);
                }
                break;
            }

            case "item/mcpToolCall/progress": {
                const params = (event.params ?? {}) as McpToolCallProgressNotification;
                if (params.itemId && params.message)
                {
                    pushReasoningDelta(params.itemId, params.message);
                }
                break;
            }

            case "item/tool/callStarted": {
                const params = (event.params ?? {}) as { callId?: string; tool?: string };
                if (params.callId && params.tool)
                {
                    pushStreamStart();
                    parts.push(withMeta({ type: "tool-input-start", id: params.callId, toolName: params.tool, dynamic: true }));
                }
                break;
            }

            case "item/tool/callDelta": {
                const params = (event.params ?? {}) as { callId?: string; delta?: string };
                if (params.callId && params.delta)
                {
                    parts.push(withMeta({ type: "tool-input-delta", id: params.callId, delta: params.delta }));
                }
                break;
            }

            case "item/tool/callFinished": {
                const params = (event.params ?? {}) as { callId?: string };
                if (params.callId)
                {
                    parts.push(withMeta({ type: "tool-input-end", id: params.callId }));
                }
                break;
            }

            case "thread/tokenUsage/updated": {
                const params = (event.params ?? {}) as ThreadTokenUsageUpdatedNotification;
                const last = params.tokenUsage?.last;
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
                break;
            }

            case "turn/completed": {
                pushStreamStart();

                for (const itemId of this.openTextParts)
                {
                    parts.push(withMeta({ type: "text-end", id: itemId }));
                }
                this.openTextParts.clear();

                for (const itemId of this.openReasoningParts)
                {
                    parts.push(withMeta({ type: "reasoning-end", id: itemId }));
                }
                this.openReasoningParts.clear();

                for (const [itemId, tracked] of this.openToolCalls)
                {
                    parts.push(withMeta({
                        type: "tool-result",
                        toolCallId: itemId,
                        toolName: tracked.toolName,
                        result: { output: tracked.output },
                    }));
                }
                this.openToolCalls.clear();

                const completed = (event.params ?? {}) as TurnCompletedNotification;
                if (completed.turn?.id)
                {
                    this.planSequenceByTurnId.delete(completed.turn.id);
                }
                const usage = this.latestUsage ?? EMPTY_USAGE;
                parts.push(withMeta({ type: "finish", finishReason: toFinishReason(completed.turn?.status), usage }));
                break;
            }

            default:
                break;
        }

        return parts;
    }
}
