import { fileURLToPath } from "node:url";

import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider";

import type { CodexTurnInputItem } from "./types";

/**
 * Extracts system messages from the prompt and concatenates them into a single
 * string suitable for `developerInstructions` on `thread/start` or
 * `thread/resume`.  Returns `undefined` when no system content is present.
 */
export function mapSystemPrompt(prompt: LanguageModelV3Prompt): string | undefined
{
    const chunks: string[] = [];

    for (const message of prompt)
    {
        if (message.role === "system")
        {
            const text = message.content.trim();
            if (text.length > 0)
            {
                chunks.push(text);
            }
        }
    }

    return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

/**
 * Maps a single `file` content part (expected to have URL data after
 * {@link PromptFileResolver.resolve}) to a Codex input item.  Returns `null`
 * for unsupported media types or non-URL data.
 */
function mapFilePart(part: LanguageModelV3FilePart): CodexTurnInputItem | null
{
    const { mediaType, data } = part;

    if (!(data instanceof URL))
    {
        // Inline data should have been resolved already — skip gracefully.
        return null;
    }

    if (mediaType.startsWith("image/"))
    {
        if (data.protocol === "file:")
        {
            return { type: "localImage", path: fileURLToPath(data) };
        }

        return { type: "image", url: data.href };
    }

    // Unsupported media type — skip silently.
    return null;
}

/**
 * Maps the prompt to the `input` array for a `turn/start` request.
 *
 * System messages are **not** included here — they are routed to
 * `developerInstructions` via {@link mapSystemPrompt} instead.
 *
 * **Important:** Call {@link PromptFileResolver.resolve} first to materialise
 * any inline file data.  This function is intentionally synchronous and
 * assumes all file parts carry URL data.
 *
 * @param isResume - When true the thread already holds the full history on
 *   disk, so only the last user message is extracted and sent.  When false
 *   (fresh thread) all user text is folded into a single item.
 */
export function mapPromptToTurnInput(
    prompt: LanguageModelV3Prompt,
    isResume: boolean = false,
): CodexTurnInputItem[]
{
    if (isResume)
    {
        return mapResumedPrompt(prompt);
    }

    return mapFreshPrompt(prompt);
}

/**
 * Resume path: extract parts from the last user message individually.
 */
function mapResumedPrompt(prompt: LanguageModelV3Prompt): CodexTurnInputItem[]
{
    for (let i = prompt.length - 1; i >= 0; i--)
    {
        const message = prompt[i];

        if (message?.role === "user")
        {
            const items: CodexTurnInputItem[] = [];

            for (const part of message.content)
            {
                if (part.type === "text")
                {
                    const text = part.text.trim();
                    if (text.length > 0)
                    {
                        items.push({ type: "text", text, text_elements: [] });
                    }
                }
                else if (part.type === "file")
                {
                    const mapped = mapFilePart(part);
                    if (mapped)
                    {
                        items.push(mapped);
                    }
                }
            }

            return items;
        }
    }

    return [];
}

/**
 * Fresh thread path: accumulate text chunks and flush before images to
 * preserve ordering.
 */
function mapFreshPrompt(prompt: LanguageModelV3Prompt): CodexTurnInputItem[]
{
    const items: CodexTurnInputItem[] = [];
    const textChunks: string[] = [];

    const flushText = (): void =>
    {
        if (textChunks.length > 0)
        {
            items.push({ type: "text", text: textChunks.join("\n\n"), text_elements: [] });
            textChunks.length = 0;
        }
    };

    for (const message of prompt)
    {
        if (message.role === "user")
        {
            for (const part of message.content)
            {
                if (part.type === "text")
                {
                    const text = part.text.trim();
                    if (text.length > 0)
                    {
                        textChunks.push(text);
                    }
                }
                else if (part.type === "file")
                {
                    const mapped = mapFilePart(part);
                    if (mapped)
                    {
                        // Image — flush accumulated text first, then emit the image.
                        flushText();
                        items.push(mapped);
                    }
                }
            }
        }
    }

    flushText();
    return items;
}
