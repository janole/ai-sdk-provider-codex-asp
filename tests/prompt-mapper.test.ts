import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { FileWriter } from "../src/utils/prompt-file-resolver";
import { mapSystemPrompt, PromptFileResolver } from "../src/utils/prompt-file-resolver";

describe("PromptFileResolver", () =>
{
    it("maps user text to text input, excluding system messages", async () =>
    {
        const resolver = new PromptFileResolver();
        const items = await resolver.resolve([
            { role: "system", content: " Be concise. " },
            {
                role: "user",
                content: [
                    { type: "text", text: " Hello " },
                ],
            },
            { role: "assistant", content: [{ type: "text", text: "ignored" }] },
        ]);

        expect(items).toEqual([
            {
                type: "text",
                text: "Hello",
                text_elements: [],
            },
        ]);
    });

    it("extracts only the last user message when resuming a thread", async () =>
    {
        const resolver = new PromptFileResolver();
        const items = await resolver.resolve(
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
        const resolver = new PromptFileResolver();
        const items = await resolver.resolve([
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
        const resolver = new PromptFileResolver();
        const items = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: new URL("file:///tmp/test-image.png") },
                ],
            },
        ]);

        expect(items).toEqual([
            { type: "localImage", path: "/tmp/test-image.png" },
        ]);
    });

    it("resolves inline image base64 to temp file and cleans up", async () =>
    {
        const resolver = new PromptFileResolver();
        // 1x1 red PNG pixel (base64)
        const base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

        const items = await resolver.resolve([
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

        await resolver.cleanup();
        expect(existsSync(path)).toBe(false);
    });

    it("resolves inline image Uint8Array to temp file and cleans up", async () =>
    {
        const resolver = new PromptFileResolver();
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header

        const items = await resolver.resolve([
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

        await resolver.cleanup();
        expect(existsSync(path)).toBe(false);
    });

    it("resolves inline text file to inlined text", async () =>
    {
        const resolver = new PromptFileResolver();
        const base64Text = Buffer.from("file content here").toString("base64");

        const items = await resolver.resolve([
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
        const resolver = new PromptFileResolver();
        const items = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "text", text: "Check this" },
                    { type: "file", mediaType: "application/pdf", data: new URL("https://example.com/doc.pdf") },
                ],
            },
        ]);

        expect(items).toEqual([
            { type: "text", text: "Check this", text_elements: [] },
        ]);
    });

    it("preserves mixed text + image ordering (text flushed before image)", async () =>
    {
        const resolver = new PromptFileResolver();
        const items = await resolver.resolve([
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
        const resolver = new PromptFileResolver();
        const items = await resolver.resolve(
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

    it("resolves mixed text file + image in fresh thread end-to-end", async () =>
    {
        const resolver = new PromptFileResolver();
        const base64Text = Buffer.from("context from file").toString("base64");

        const items = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "text", text: "Hello" },
                    { type: "file", mediaType: "text/plain", data: base64Text },
                    { type: "file", mediaType: "image/jpeg", data: new URL("https://example.com/photo.jpg") },
                ],
            },
        ]);

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

        const items = await resolver.resolve([
            {
                role: "user",
                content: [
                    { type: "file", mediaType: "image/png", data: base64Png },
                ],
            },
        ]);

        expect(written).toHaveLength(1);
        expect(written[0]!.mediaType).toBe("image/png");

        // S3 URL → mapped to CodexTurnInputImage.
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
