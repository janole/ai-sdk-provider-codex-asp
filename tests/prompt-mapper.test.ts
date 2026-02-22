import { describe, expect, it } from "vitest";

import { mapPromptToTurnInput } from "../src/protocol/prompt-mapper";

describe("mapPromptToTurnInput", () =>
{
    it("maps prompt text to v2 text user input", () =>
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
                text: "Be concise.\n\nHello",
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
