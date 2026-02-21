import type {
    LanguageModelV3FinishReason,
    LanguageModelV3StreamPart,
    LanguageModelV3Usage,
} from "@ai-sdk/provider";

export interface CodexEventMapperInput {
    method: string;
    params?: unknown;
}

interface ItemLike {
    itemId?: string;
    itemType?: string;
}

interface DeltaLike {
    itemId?: string;
    delta?: string;
}

interface TurnCompletedLike {
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
    private threadId: string | undefined;

    setThreadId(threadId: string): void
    {
        this.threadId = threadId;
    }

    map(event: CodexEventMapperInput): LanguageModelV3StreamPart[] 
    {
        const parts: LanguageModelV3StreamPart[] = [];
        const pushStreamStart = () => 
        {
            if (!this.streamStarted) 
            {
                parts.push({ type: "stream-start", warnings: [] });
                this.streamStarted = true;
            }
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
                    parts.push({ type: "text-start", id: item.itemId });
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
                    parts.push({ type: "text-start", id: delta.itemId });
                }

                parts.push({ type: "text-delta", id: delta.itemId, delta: delta.delta });
                break;
            }

            case "item/completed": {
                const item = (event.params ?? {}) as ItemLike;
                if (item.itemType === "assistantMessage" && item.itemId && this.openTextParts.has(item.itemId)) 
                {
                    parts.push({ type: "text-end", id: item.itemId });
                    this.openTextParts.delete(item.itemId);
                }
                break;
            }

            case "item/tool/callStarted": {
                const params = (event.params ?? {}) as { callId?: string; tool?: string };
                if (params.callId && params.tool) 
                {
                    pushStreamStart();
                    parts.push({ type: "tool-input-start", id: params.callId, toolName: params.tool, dynamic: true });
                }
                break;
            }

            case "item/tool/callDelta": {
                const params = (event.params ?? {}) as { callId?: string; delta?: string };
                if (params.callId && params.delta) 
                {
                    parts.push({ type: "tool-input-delta", id: params.callId, delta: params.delta });
                }
                break;
            }

            case "item/tool/callFinished": {
                const params = (event.params ?? {}) as { callId?: string };
                if (params.callId) 
                {
                    parts.push({ type: "tool-input-end", id: params.callId });
                }
                break;
            }

            case "turn/completed": {
                pushStreamStart();

                for (const itemId of this.openTextParts) 
                {
                    parts.push({ type: "text-end", id: itemId });
                }
                this.openTextParts.clear();

                const completed = (event.params ?? {}) as TurnCompletedLike;
                parts.push({
                    type: "finish",
                    finishReason: toFinishReason(completed.status),
                    usage: EMPTY_USAGE,
                    ...(this.threadId
                        ? { providerMetadata: { "codex-app-server": { threadId: this.threadId } } }
                        : {}),
                });
                break;
            }

            default:
                break;
        }

        return parts;
    }
}
