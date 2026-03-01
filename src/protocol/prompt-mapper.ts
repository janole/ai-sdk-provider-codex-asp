import { fileURLToPath } from "node:url";

import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider";

import { cleanupTempFiles, writeTempFile } from "../utils/temp-file";
import type { CodexTurnInputItem } from "./types";

export interface PromptMappingResult
{
    items: CodexTurnInputItem[];
    cleanup: () => Promise<void>;
}

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
 * Maps a single `file` content part to a Codex input item, writing temp files
 * when the data is inline (base64 / Uint8Array).  Returns `null` for
 * unsupported media types.
 */
async function mapFilePart(
    part: LanguageModelV3FilePart,
    tempFiles: string[],
): Promise<CodexTurnInputItem | null>
{
    const { mediaType, data } = part;

    // ── Text files → inline as text ──
    if (mediaType.startsWith("text/"))
    {
        let text: string;
        if (data instanceof URL)
        {
            // We don't fetch remote text files; treat URL as a reference.
            text = data.href;
        }
        else if (typeof data === "string")
        {
            text = Buffer.from(data, "base64").toString("utf-8");
        }
        else
        {
            text = new TextDecoder().decode(data);
        }

        return { type: "text", text, text_elements: [] };
    }

    // ── Images ──
    if (mediaType.startsWith("image/"))
    {
        if (data instanceof URL)
        {
            if (data.protocol === "file:")
            {
                return { type: "localImage", path: fileURLToPath(data) };
            }

            // http: / https:
            return { type: "image", url: data.href };
        }

        // Inline data → write temp file
        const path = await writeTempFile(data, mediaType);
        tempFiles.push(path);
        return { type: "localImage", path };
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
 * @param isResume - When true the thread already holds the full history on
 *   disk, so only the last user message is extracted and sent.  When false
 *   (fresh thread) all user text is folded into a single item.
 *
 * @returns A `PromptMappingResult` containing the mapped items and a `cleanup`
 *   callback that removes any temporary files created during mapping.
 */
export async function mapPromptToTurnInput(
    prompt: LanguageModelV3Prompt,
    isResume: boolean = false,
): Promise<PromptMappingResult>
{
    const tempFiles: string[] = [];

    const cleanup = async (): Promise<void> =>
    {
        if (tempFiles.length > 0)
        {
            await cleanupTempFiles(tempFiles);
        }
    };

    if (isResume)
    {
        const items = await mapResumedPrompt(prompt, tempFiles);
        return { items, cleanup };
    }

    const items = await mapFreshPrompt(prompt, tempFiles);
    return { items, cleanup };
}

/**
 * Resume path: extract parts from the last user message individually.
 */
async function mapResumedPrompt(
    prompt: LanguageModelV3Prompt,
    tempFiles: string[],
): Promise<CodexTurnInputItem[]>
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
                    const mapped = await mapFilePart(part, tempFiles);
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
async function mapFreshPrompt(
    prompt: LanguageModelV3Prompt,
    tempFiles: string[],
): Promise<CodexTurnInputItem[]>
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
                    const mapped = await mapFilePart(part, tempFiles);
                    if (mapped)
                    {
                        if (mapped.type === "text")
                        {
                            // Text file content gets inlined into text chunks.
                            textChunks.push(mapped.text);
                        }
                        else
                        {
                            // Image — flush accumulated text first, then emit the image.
                            flushText();
                            items.push(mapped);
                        }
                    }
                }
            }
        }
    }

    flushText();
    return items;
}
