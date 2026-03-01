import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { mapPromptToTurnInput, mapSystemPrompt } from "../src/protocol/prompt-mapper";
import type { FileWriter } from "../src/utils/file-resolver";
import { PromptFileResolver } from "../src/utils/file-resolver";

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

    it("maps image URL (https) to CodexTurnInputImage", () =>
    {
        const result = mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: new URL("https://example.com/img.png") },
                ],
            },
        ]);

        expect(result).toEqual([
            { type: "image", url: "https://example.com/img.png" },
        ]);
    });

    it("maps image URL (file:) to CodexTurnInputLocalImage", () =>
    {
        const fileUrl = pathToFileURL("/tmp/test-image.png");
        const result = mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: fileUrl },
                ],
            },
        ]);

        expect(result).toEqual([
            { type: "localImage", path: "/tmp/test-image.png" },
        ]);
    });

    it("skips unsupported media types (application/pdf)", () =>
    {
        const result = mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "text", text: "Check this" },
                    { type: "file", mediaType: "application/pdf", data: new URL("https://example.com/doc.pdf") },
                ],
            },
        ]);

        expect(result).toEqual([
            { type: "text", text: "Check this", text_elements: [] },
        ]);
    });

    it("preserves mixed text + image ordering (text flushed before image)", () =>
    {
        const result = mapPromptToTurnInput([
            {
                role: "user",
                content: [
                    { type: "text", text: "Before image" },
                    { type: "file", mediaType: "image/jpeg", data: new URL("https://example.com/photo.jpg") },
                    { type: "text", text: "After image" },
                ],
            },
        ]);

        expect(result).toEqual([
            { type: "text", text: "Before image", text_elements: [] },
            { type: "image", url: "https://example.com/photo.jpg" },
            { type: "text", text: "After image", text_elements: [] },
        ]);
    });

    it("resume mode with text + image returns both items", () =>
    {
        const result = mapPromptToTurnInput(
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

        expect(result).toEqual([
            { type: "text", text: "Look at this", text_elements: [] },
            { type: "image", url: "https://example.com/img.png" },
        ]);
    });
});

describe("PromptFileResolver", () =>
{
    it("resolves inline text file to text part", async () =>
    {
        const resolver = new PromptFileResolver();
        const base64Text = Buffer.from("file content here").toString("base64");

        const prompt = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "text/plain", data: base64Text },
                ],
            },
        ]);

        const userMsg = prompt.find((m) => m.role === "user");
        expect(userMsg).toBeDefined();
        if (userMsg?.role === "user")
        {
            expect(userMsg.content).toEqual([
                { type: "text", text: "file content here" },
            ]);
        }

        await resolver.cleanup();
    });

    it("resolves inline image base64 to file: URL and cleans up", async () =>
    {
        const resolver = new PromptFileResolver();
        // 1x1 red PNG pixel (base64)
        const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

        const prompt = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: base64Png },
                ],
            },
        ]);

        const userMsg = prompt.find((m) => m.role === "user");
        expect(userMsg).toBeDefined();
        if (userMsg?.role === "user")
        {
            const part = userMsg.content[0];
            expect(part?.type).toBe("file");
            if (part?.type === "file")
            {
                expect(part.data).toBeInstanceOf(URL);
                expect((part.data as URL).protocol).toBe("file:");
                const path = (part.data as URL).pathname;
                expect(path).toMatch(/codex-ai-sdk-.*\.png$/);
                expect(existsSync(path)).toBe(true);

                await resolver.cleanup();
                expect(existsSync(path)).toBe(false);
            }
        }
    });

    it("resolves inline image Uint8Array to file: URL and cleans up", async () =>
    {
        const resolver = new PromptFileResolver();
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header

        const prompt = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: bytes },
                ],
            },
        ]);

        const userMsg = prompt.find((m) => m.role === "user");
        if (userMsg?.role === "user")
        {
            const part = userMsg.content[0];
            if (part?.type === "file")
            {
                const path = (part.data as URL).pathname;
                expect(existsSync(path)).toBe(true);

                await resolver.cleanup();
                expect(existsSync(path)).toBe(false);
            }
        }
    });

    it("passes through URL-based file parts unchanged", async () =>
    {
        const resolver = new PromptFileResolver();
        const url = new URL("https://example.com/img.png");
        const original = [
            {
                role: "user" as const,
                content: [
                    { type: "file" as const, mediaType: "image/png", data: url },
                ],
            },
        ];

        const prompt = await resolver.resolve(original);

        // No inline data to resolve — should return the original prompt.
        expect(prompt).toBe(original);
        await resolver.cleanup();
    });

    it("resolves mixed text file + image in fresh thread end-to-end", async () =>
    {
        const resolver = new PromptFileResolver();
        const base64Text = Buffer.from("context from file").toString("base64");

        const prompt = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "text", text: "Hello" },
                    { type: "file", mediaType: "text/plain", data: base64Text },
                    { type: "file", mediaType: "image/jpeg", data: new URL("https://example.com/photo.jpg") },
                ],
            },
        ]);

        const items = mapPromptToTurnInput(prompt);

        expect(items).toEqual([
            { type: "text", text: "Hello\n\ncontext from file", text_elements: [] },
            { type: "image", url: "https://example.com/photo.jpg" },
        ]);

        await resolver.cleanup();
    });

    it("accepts a custom FileWriter", async () =>
    {
        const written: Array<{ data: Uint8Array | string; mediaType: string }> = [];
        let cleanedUp = false;

        const customWriter: FileWriter = {
            write(data, mediaType)
            {
                written.push({ data, mediaType });
                return Promise.resolve(new URL("https://my-bucket.s3.amazonaws.com/resolved-image.png"));
            },
            cleanup()
            {
                cleanedUp = true;
                return Promise.resolve();
            },
        };

        const resolver = new PromptFileResolver(customWriter);
        const base64Png = "iVBORw0KGgo=";

        const prompt = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: base64Png },
                ],
            },
        ]);

        expect(written).toHaveLength(1);
        expect(written[0]!.mediaType).toBe("image/png");

        // The resolved URL is https — mapper maps it to CodexTurnInputImage.
        const items = mapPromptToTurnInput(prompt);
        expect(items).toEqual([
            { type: "image", url: "https://my-bucket.s3.amazonaws.com/resolved-image.png" },
        ]);

        await resolver.cleanup();
        expect(cleanedUp).toBe(true);
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
