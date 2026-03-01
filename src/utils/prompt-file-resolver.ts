import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LanguageModelV3FilePart, LanguageModelV3Prompt } from "@ai-sdk/provider";

import type { CodexTurnInputItem, CodexTurnInputText } from "../protocol/types";

// ── System prompt extraction ──

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

// ── Helpers ──

function textItem(text: string): CodexTurnInputText
{
    return { type: "text", text, text_elements: [] };
}

// ── File writer interface ──

/**
 * Pluggable backend for persisting inline binary data so that the Codex
 * protocol can reference it by URL.
 *
 * Implement this interface to use a different storage backend (e.g. S3, GCS).
 *
 * - A `file:` URL maps to `{ type: "localImage", path }` in the Codex protocol.
 * - An `http(s):` URL maps to `{ type: "image", url }`.
 */
export interface FileWriter
{
    /** Persist `data` and return a URL that Codex can use to access it. */
    write(data: Uint8Array | string, mediaType: string): Promise<URL>;

    /**
     * Remove previously written files.  Best-effort — implementations should
     * never throw.
     */
    cleanup(urls: URL[]): Promise<void>;
}

// ── Local filesystem writer ──

const MEDIA_TYPE_TO_EXT: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
};

function extensionForMediaType(mediaType: string): string
{
    return MEDIA_TYPE_TO_EXT[mediaType] ?? ".bin";
}

/**
 * A {@link FileWriter} that writes to `os.tmpdir()` and returns `file:` URLs.
 */
export class LocalFileWriter implements FileWriter
{
    async write(data: Uint8Array | string, mediaType: string): Promise<URL>
    {
        const ext = extensionForMediaType(mediaType);
        const filename = `codex-ai-sdk-${randomUUID()}${ext}`;
        const filepath = join(tmpdir(), filename);

        const buffer = typeof data === "string"
            ? Buffer.from(data, "base64")
            : data;

        await writeFile(filepath, buffer);
        return pathToFileURL(filepath);
    }

    async cleanup(urls: URL[]): Promise<void>
    {
        await Promise.allSettled(
            urls
                .filter((u) => u.protocol === "file:")
                .map((u) => unlink(u)),
        );
    }
}

// ── Resolver class ──

/**
 * Resolves inline binary data in AI SDK prompts and maps user content to
 * {@link CodexTurnInputItem} arrays ready for `turn/start`.
 *
 * Instantiate with an optional custom {@link FileWriter} for non-local storage
 * (e.g. S3).  Tracks all written URLs so that {@link cleanup} can remove them
 * after the turn completes.
 *
 * @example
 * ```ts
 * const fileResolver = new PromptFileResolver();
 * const turnInput = await fileResolver.resolve(prompt, isResume);
 * // … after the turn …
 * await fileResolver.cleanup();
 * ```
 */
export class PromptFileResolver
{
    private readonly writer: FileWriter;
    private readonly written: URL[] = [];

    constructor(writer?: FileWriter)
    {
        this.writer = writer ?? new LocalFileWriter();
    }

    /**
     * Resolve inline file data and map user content to Codex input items.
     *
     * - Inline image data (base64 / Uint8Array) is written via the
     *   {@link FileWriter} and converted to `localImage` or `image` items.
     * - URL-based image file parts are converted directly.
     * - Inline text file data is decoded and inlined as text.
     * - Unsupported media types are silently skipped.
     *
     * @param isResume - When true only the last user message is extracted.
     *   When false (fresh thread) all user text is accumulated with images
     *   flushing the text buffer to preserve ordering.
     */
    async resolve(
        prompt: LanguageModelV3Prompt,
        isResume: boolean = false,
    ): Promise<CodexTurnInputItem[]>
    {
        if (isResume)
        {
            return this.resolveResumed(prompt);
        }

        return this.resolveFresh(prompt);
    }

    /**
     * Remove all files created by previous {@link resolve} calls.
     * Best-effort — never throws.
     */
    async cleanup(): Promise<void>
    {
        const urls = this.written.splice(0);
        if (urls.length > 0)
        {
            await this.writer.cleanup(urls);
        }
    }

    // ── Private helpers ──

    /**
     * Convert a resolved image URL to a Codex input item.
     */
    private mapImageUrl(mediaType: string, data: URL): CodexTurnInputItem | null
    {
        if (!mediaType.startsWith("image/"))
        {
            return null;
        }

        if (data.protocol === "file:")
        {
            return { type: "localImage", path: fileURLToPath(data) };
        }

        return { type: "image", url: data.href };
    }

    /**
     * Resolve a single file part: write inline data via the writer, then
     * convert to a Codex input item.  Text files are decoded and returned
     * as text items.  Returns `null` for unsupported media types.
     */
    private async resolveFilePart(
        part: LanguageModelV3FilePart,
    ): Promise<CodexTurnInputItem | null>
    {
        const { mediaType, data } = part;

        // Text files → decode and inline as text.
        // URL text files pass through as the URL string — we don't fetch remote
        // content; the URL itself serves as a reference for the model.
        if (mediaType.startsWith("text/"))
        {
            if (data instanceof URL)
            {
                return textItem(data.href);
            }

            const text = typeof data === "string"
                ? Buffer.from(data, "base64").toString("utf-8")
                : new TextDecoder().decode(data);
            return textItem(text);
        }

        // Images with inline data → write via writer, then map the URL.
        if (mediaType.startsWith("image/") && !(data instanceof URL))
        {
            const url = await this.writer.write(data, mediaType);
            this.written.push(url);
            return this.mapImageUrl(mediaType, url);
        }

        // Images that already have a URL → map directly.
        if (data instanceof URL)
        {
            return this.mapImageUrl(mediaType, data);
        }

        return null;
    }

    /**
     * Resume path: extract parts from the last user message individually.
     */
    private async resolveResumed(
        prompt: LanguageModelV3Prompt,
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
                            items.push(textItem(text));
                        }
                    }
                    else if (part.type === "file")
                    {
                        const mapped = await this.resolveFilePart(part);
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
     * Fresh thread path: accumulate text chunks across all user messages,
     * flushing before each image to preserve ordering.
     */
    private async resolveFresh(
        prompt: LanguageModelV3Prompt,
    ): Promise<CodexTurnInputItem[]>
    {
        const items: CodexTurnInputItem[] = [];
        const textChunks: string[] = [];

        const flushText = (): void =>
        {
            if (textChunks.length > 0)
            {
                items.push(textItem(textChunks.join("\n\n")));
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
                        const mapped = await this.resolveFilePart(part);
                        if (mapped)
                        {
                            if (mapped.type === "text")
                            {
                                textChunks.push(mapped.text);
                            }
                            else
                            {
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
}
