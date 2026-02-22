import { describe, expect, it } from "vitest";

import { mapPromptToTurnInput, mapSystemPrompt } from "../src/protocol/prompt-mapper";

describe("mapPromptToTurnInput", () =>
{
    it("maps user text to v2 text input, excluding system messages", () =>
    {
        const result = mapPromptToTurnInput([
            { role: "system", content: " Be concise. " },
            {
                role: "user",
                content: [
                    { type: "text", text: " Hello " },
                    { type: "file", mediaType: "text/plain", data: "aGVsbG8=" },
                ],
            },
            { role: "assistant", content: [{ type: "text", text: "ignored" }] },
        ]);

        expect(result).toEqual([
            {
                type: "text",
                text: "Hello",
                text_elements: [],
            },
        ]);
    });

    it("extracts only the last user message when resuming a thread", () =>
    {
        const result = mapPromptToTurnInput(
            [
                { role: "system", content: "Be concise." },
                { role: "user", content: [{ type: "text", text: "first message" }] },
                { role: "assistant", content: [{ type: "text", text: "first reply" }] },
                { role: "user", content: [{ type: "text", text: "second message" }] },
                { role: "assistant", content: [{ type: "text", text: "second reply" }] },
                { role: "user", content: [{ type: "text", text: "third message" }] },
            ],
            true,
        );

        expect(result).toEqual([
            { type: "text", text: "third message", text_elements: [] },
        ]);
    });
});

describe("mapSystemPrompt", () =>
{
    it("extracts and concatenates system messages", () =>
    {
        const result = mapSystemPrompt([
            { role: "system", content: " Be concise. " },
            { role: "user", content: [{ type: "text", text: "Hello" }] },
            { role: "system", content: " Use JSON. " },
        ]);

        expect(result).toBe("Be concise.\n\nUse JSON.");
    });

    it("returns undefined when there are no system messages", () =>
    {
        const result = mapSystemPrompt([
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ]);

        expect(result).toBeUndefined();
    });
});
