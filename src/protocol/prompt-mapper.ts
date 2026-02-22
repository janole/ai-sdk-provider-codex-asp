import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

import type { CodexTurnInputItem } from "./types";

/**
 * Maps the prompt to the `input` array for a `turn/start` request.
 *
 * @param isResume - When true the thread already holds the full history on
 *   disk, so only the last user message is extracted and sent.  When false
 *   (fresh thread) all system + user text is folded into a single item.
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

    // Fresh thread: flatten system + all user text into one item (POC behaviour).
    const chunks: string[] = [];

    for (const message of prompt)
    {
        switch (message.role)
        {
            case "system": {
                const text = message.content.trim();
                if (text.length > 0)
                {
                    chunks.push(text);
                }
                break;
            }

            case "user": {
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
                break;
            }

            default:
                break;
        }
    }

    return [{ type: "text", text: chunks.join("\n\n"), text_elements: [] }];
}
