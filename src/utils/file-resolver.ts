import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { LanguageModelV3Prompt } from "@ai-sdk/provider";

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
 * Resolves inline binary data in AI SDK prompts into URLs that the sync
 * {@link mapPromptToTurnInput} can handle.
 *
 * Instantiate with an optional custom {@link FileWriter} for non-local storage
 * (e.g. S3).  Tracks all written URLs so that {@link cleanup} can remove them
 * after the turn completes.
 *
 * @example
 * ```ts
 * const resolver = new PromptFileResolver();
 * const resolved = await resolver.resolve(prompt);
 * const items = mapPromptToTurnInput(resolved, isResume);
 * // … after the turn …
 * await resolver.cleanup();
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
     * Walk the prompt, replacing inline file data with URLs.
     *
     * - Inline image data (base64 / Uint8Array) is written via the
     *   {@link FileWriter} and replaced with the returned URL.
     * - Inline text file data is decoded to a `text` part in-place.
     * - URL-based file parts and non-file parts pass through unchanged.
     *
     * Returns the original prompt reference when no parts needed resolution.
     */
    async resolve(prompt: LanguageModelV3Prompt): Promise<LanguageModelV3Prompt>
    {
        let changed = false;
        const resolved: LanguageModelV3Prompt = [];

        for (const message of prompt)
        {
            if (message.role !== "user")
            {
                resolved.push(message);
                continue;
            }

            const parts: typeof message.content = [];
            for (const part of message.content)
            {
                if (part.type === "file" && !(part.data instanceof URL))
                {
                    if (part.mediaType.startsWith("image/"))
                    {
                        const url = await this.writer.write(part.data, part.mediaType);
                        this.written.push(url);
                        parts.push({ ...part, data: url });
                        changed = true;
                        continue;
                    }

                    if (part.mediaType.startsWith("text/"))
                    {
                        const text = typeof part.data === "string"
                            ? Buffer.from(part.data, "base64").toString("utf-8")
                            : new TextDecoder().decode(part.data);
                        parts.push({ type: "text", text });
                        changed = true;
                        continue;
                    }
                }

                parts.push(part);
            }

            resolved.push({ ...message, content: parts });
        }

        return changed ? resolved : prompt;
    }

    /**
     * Remove all files created by previous {@link resolve} calls.
     * Best-effort — never throws.
     */
    async cleanup(): Promise<void>
    {
        if (this.written.length > 0)
        {
            await this.writer.cleanup(this.written);
            this.written.length = 0;
        }
    }
}
