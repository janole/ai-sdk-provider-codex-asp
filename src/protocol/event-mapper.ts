import type {
    LanguageModelV3FinishReason,
    LanguageModelV3StreamPart,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";

import { withProviderMetadata } from "./provider-metadata";

export interface CodexEventMapperInput
{
    method: string;
    params?: unknown;
}

interface ItemLike
{
    itemId?: string;
    itemType?: string;
}

interface CommandExecutionItemLike extends ItemLike
{
    command?: string | string[];
    cwd?: string;
    item?: {
        command?: string | string[];
        cwd?: string;
        exitCode?: number;
        status?: string;
        aggregatedOutput?: string;
    };
    exitCode?: number;
    status?: string;
    aggregatedOutput?: string;
}

interface DeltaLike
{
    itemId?: string;
    delta?: string;
}
interface ProgressLike
{
    itemId?: string;
    message?: string;
}

interface TurnCompletedLike
{
    status?: "completed" | "interrupted" | "failed";
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

function toFinishReason(status: TurnCompletedLike["status"]): LanguageModelV3FinishReason 
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

export class CodexEventMapper
{
    private streamStarted = false;
    private readonly openTextParts = new Set<string>();
    private readonly openReasoningParts = new Set<string>();
    private readonly openToolCalls = new Map<string, { toolName: string; output: string }>();
    private threadId: string | undefined;

    setThreadId(threadId: string): void
    {
        this.threadId = threadId;
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
                const item = (event.params ?? {}) as ItemLike;
                if (item.itemType === "assistantMessage" && item.itemId)
                {
                    pushStreamStart();
                    this.openTextParts.add(item.itemId);
                    parts.push(withMeta({ type: "text-start", id: item.itemId }));
                }
                else if (item.itemType === "commandExecution" && item.itemId)
                {
                    pushStreamStart();
                    const cmdItem = event.params as CommandExecutionItemLike;
                    const command = cmdItem.command ?? cmdItem.item?.command;
                    const cwd = cmdItem.cwd ?? cmdItem.item?.cwd;
                    const toolName = "codex_command_execution";

                    this.openToolCalls.set(item.itemId, { toolName, output: "" });
                    parts.push(withMeta({
                        type: "tool-call",
                        toolCallId: item.itemId,
                        toolName,
                        input: JSON.stringify({ command, cwd }),
                        providerExecuted: true,
                    }));
                }
                else if (
                    item.itemId
                    && (item.itemType === "reasoning"
                        || item.itemType === "plan"
                        || item.itemType === "fileChange"
                        || item.itemType === "mcpToolCall")
                )
                {
                    pushReasoningDelta(item.itemId, "");
                }
                break;
            }

            case "item/agentMessage/delta": {
                const delta = (event.params ?? {}) as DeltaLike;
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
                break;
            }

            case "item/completed": {
                const item = (event.params ?? {}) as ItemLike;
                if (item.itemType === "assistantMessage" && item.itemId && this.openTextParts.has(item.itemId))
                {
                    parts.push(withMeta({ type: "text-end", id: item.itemId }));
                    this.openTextParts.delete(item.itemId);
                }
                else if (item.itemType === "commandExecution" && item.itemId && this.openToolCalls.has(item.itemId))
                {
                    const tracked = this.openToolCalls.get(item.itemId)!;
                    const cmdItem = event.params as CommandExecutionItemLike;
                    const output = cmdItem.aggregatedOutput ?? cmdItem.item?.aggregatedOutput ?? tracked.output;
                    const exitCode = cmdItem.exitCode ?? cmdItem.item?.exitCode;
                    const status = cmdItem.status ?? cmdItem.item?.status;

                    parts.push(withMeta({
                        type: "tool-result",
                        toolCallId: item.itemId,
                        toolName: tracked.toolName,
                        result: { output, exitCode, status },
                    }));
                    this.openToolCalls.delete(item.itemId);
                }
                else if (
                    item.itemId
                    && this.openReasoningParts.has(item.itemId)
                    && (item.itemType === "reasoning"
                        || item.itemType === "plan"
                        || item.itemType === "fileChange"
                        || item.itemType === "mcpToolCall")
                )
                {
                    parts.push(withMeta({ type: "reasoning-end", id: item.itemId }));
                    this.openReasoningParts.delete(item.itemId);
                }
                break;
            }

            case "item/reasoning/textDelta":
            case "item/reasoning/summaryTextDelta":
            case "item/plan/delta":
            case "item/fileChange/outputDelta": {
                const delta = (event.params ?? {}) as DeltaLike;
                if (delta.itemId && delta.delta)
                {
                    pushReasoningDelta(delta.itemId, delta.delta);
                }
                break;
            }

            case "item/commandExecution/outputDelta": {
                const delta = (event.params ?? {}) as DeltaLike;
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

            case "item/mcpToolCall/progress": {
                const params = (event.params ?? {}) as ProgressLike;
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

                const completed = (event.params ?? {}) as TurnCompletedLike;
                parts.push(withMeta({ type: "finish", finishReason: toFinishReason(completed.status), usage: EMPTY_USAGE }));
                break;
            }

            default:
                break;
        }

        return parts;
    }
}
