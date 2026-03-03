import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

import { CodexProviderError } from "../errors";
import { CODEX_PROVIDER_ID } from "./provider-metadata";
import type {
    CodexThreadStartResult,
    CodexToolCallResult,
    CodexToolResultContentItem,
    CodexTurnStartResult,
} from "./types";

interface ThreadStartResultLike extends CodexThreadStartResult
{
    thread?: {
        id?: string;
    };
}

interface TurnStartResultLike extends CodexTurnStartResult
{
    turn?: {
        id?: string;
    };
}

export function extractThreadId(result: ThreadStartResultLike): string
{
    const threadId = result.threadId ?? result.thread?.id;
    if (!threadId)
    {
        throw new CodexProviderError("thread/start response does not include a thread id.");
    }
    return threadId;
}

export function extractTurnId(result: TurnStartResultLike): string
{
    const turnId = result.turnId ?? result.turn?.id;
    if (!turnId)
    {
        throw new CodexProviderError("turn/start response does not include a turn id.");
    }
    return turnId;
}

export function extractThreadIdFromProviderOptions(
    providerOptions: Record<string, unknown> | undefined,
): string | undefined
{
    const meta = providerOptions?.[CODEX_PROVIDER_ID];
    if (meta && typeof meta === "object" && "threadId" in meta && typeof (meta as Record<string, unknown>)["threadId"] === "string")
    {
        return (meta as Record<string, unknown>)["threadId"] as string;
    }
    return undefined;
}

export function extractResumeThreadId(prompt: LanguageModelV3CallOptions["prompt"]): string | undefined
{
    for (let i = prompt.length - 1; i >= 0; i--)
    {
        const message = prompt[i];
        if (message?.role === "assistant")
        {
            // Check message-level providerOptions
            const messageThreadId = extractThreadIdFromProviderOptions(
                message.providerOptions as Record<string, unknown> | undefined,
            );
            if (messageThreadId)
            {
                return messageThreadId;
            }

            // Check content-part-level providerOptions
            if (Array.isArray(message.content))
            {
                for (const part of message.content)
                {
                    const partThreadId = extractThreadIdFromProviderOptions(
                        (part as { providerOptions?: Record<string, unknown> }).providerOptions,
                    );
                    if (partThreadId)
                    {
                        return partThreadId;
                    }
                }
            }
        }
    }
    return undefined;
}

export function extractToolResults(
    prompt: LanguageModelV3CallOptions["prompt"],
    callId?: string,
): CodexToolCallResult | undefined
{
    for (let i = prompt.length - 1; i >= 0; i--)
    {
        const message = prompt[i];
        if (message?.role === "tool")
        {
            const contentItems: CodexToolResultContentItem[] = [];
            let success = true;

            for (const part of message.content)
            {
                if (part.type === "tool-result")
                {
                    if (callId && part.toolCallId !== callId)
                    {
                        continue;
                    }

                    if (part.output.type === "text")
                    {
                        contentItems.push({ type: "inputText", text: part.output.value });
                    }
                    else if (part.output.type === "json")
                    {
                        contentItems.push({ type: "inputText", text: JSON.stringify(part.output.value) });
                    }
                    else if (part.output.type === "execution-denied")
                    {
                        success = false;
                        contentItems.push({
                            type: "inputText",
                            text: part.output.reason ?? "Tool execution was denied.",
                        });
                    }
                }
            }

            if (contentItems.length > 0)
            {
                return { success, contentItems };
            }

            if (callId)
            {
                // A matching callId was requested, so don't consume unrelated
                // tool results from older prompt entries.
                return undefined;
            }
        }
    }
    return undefined;
}
