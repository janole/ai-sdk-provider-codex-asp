import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

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
 * Maps the prompt to the `input` array for a `turn/start` request.
 *
 * System messages are **not** included here — they are routed to
 * `developerInstructions` via {@link mapSystemPrompt} instead.
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
                }

                return items;
            }
        }

        return [];
    }

    // Fresh thread: flatten all user text into one item.
    const chunks: string[] = [];

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
                        chunks.push(text);
                    }
                }
            }
        }
    }

    return [{ type: "text", text: chunks.join("\n\n"), text_elements: [] }];
}
