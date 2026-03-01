import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { mapPromptToTurnInput, mapSystemPrompt } from "../src/protocol/prompt-mapper";

describe("mapPromptToTurnInput", () =>
{
    it("maps user text to v2 text input, excluding system messages", async () =>
    {
        const { items } = await mapPromptToTurnInput([
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

        expect(items).toEqual([
            {
                type: "text",
                text: "Hello\n\nhello",
                text_elements: [],
            },
        ]);
    });

    it("extracts only the last user message when resuming a thread", async () =>
    {
        const { items } = await mapPromptToTurnInput(
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

        expect(items).toEqual([
            { type: "text", text: "third message", text_elements: [] },
        ]);
    });

    it("maps image URL (https) to CodexTurnInputImage", async () =>
    {
        const { items } = await mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: new URL("https://example.com/img.png") },
                ],
            },
        ]);

        expect(items).toEqual([
            { type: "image", url: "https://example.com/img.png" },
        ]);
    });

    it("maps image URL (file:) to CodexTurnInputLocalImage", async () =>
    {
        const fileUrl = pathToFileURL("/tmp/test-image.png");
        const { items } = await mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: fileUrl },
                ],
            },
        ]);

        expect(items).toEqual([
            { type: "localImage", path: "/tmp/test-image.png" },
        ]);
    });

    it("maps image base64 to temp file and cleans up", async () =>
    {
        // 1x1 red PNG pixel (base64)
        const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

        const { items, cleanup } = await mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: base64Png },
                ],
            },
        ]);

        expect(items).toHaveLength(1);
        expect(items[0]!.type).toBe("localImage");
        const path = (items[0] as { type: "localImage"; path: string }).path;
        expect(path).toMatch(/codex-ai-sdk-.*\.png$/);
        expect(existsSync(path)).toBe(true);

        await cleanup();
        expect(existsSync(path)).toBe(false);
    });

    it("maps image Uint8Array to temp file and cleans up", async () =>
    {
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header

        const { items, cleanup } = await mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: bytes },
                ],
            },
        ]);

        expect(items).toHaveLength(1);
        expect(items[0]!.type).toBe("localImage");
        const path = (items[0] as { type: "localImage"; path: string }).path;
        expect(existsSync(path)).toBe(true);

        await cleanup();
        expect(existsSync(path)).toBe(false);
    });

    it("maps text file (base64) to inlined text", async () =>
    {
        const base64Text = Buffer.from("file content here").toString("base64");

        const { items } = await mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "text/plain", data: base64Text },
                ],
            },
        ]);

        expect(items).toEqual([
            { type: "text", text: "file content here", text_elements: [] },
        ]);
    });

    it("skips unsupported media types (application/pdf)", async () =>
    {
        const { items } = await mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "text", text: "Check this" },
                    { type: "file", mediaType: "application/pdf", data: "AAAA" },
                ],
            },
        ]);

        expect(items).toEqual([
            { type: "text", text: "Check this", text_elements: [] },
        ]);
    });

    it("preserves mixed text + image ordering (text flushed before image)", async () =>
    {
        const { items } = await mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "text", text: "Before image" },
                    { type: "file", mediaType: "image/jpeg", data: new URL("https://example.com/photo.jpg") },
                    { type: "text", text: "After image" },
                ],
            },
        ]);

        expect(items).toEqual([
            { type: "text", text: "Before image", text_elements: [] },
            { type: "image", url: "https://example.com/photo.jpg" },
            { type: "text", text: "After image", text_elements: [] },
        ]);
    });

    it("resume mode with text + image returns both items", async () =>
    {
        const { items } = await mapPromptToTurnInput(
            [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Look at this" },
                        { type: "file", mediaType: "image/png", data: new URL("https://example.com/img.png") },
                    ],
                },
            ],
            true,
        );

        expect(items).toEqual([
            { type: "text", text: "Look at this", text_elements: [] },
            { type: "image", url: "https://example.com/img.png" },
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
