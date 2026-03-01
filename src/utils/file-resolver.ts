import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Abstraction for persisting inline binary data so that the Codex protocol
 * can reference it by URL.
 *
 * The default implementation ({@link createLocalFileResolver}) writes to the
 * local filesystem.  Provide a custom implementation to use a different
 * backend (e.g. S3, GCS, or an in-memory store).
 */
export interface FileResolver
{
    /**
     * Persist `data` and return a URL that Codex can use to access it.
     *
     * - A `file:` URL maps to `{ type: "localImage", path }`.
     * - An `http(s):` URL maps to `{ type: "image", url }`.
     */
    write(data: Uint8Array | string, mediaType: string): Promise<URL>;

    /**
     * Remove all files created by previous {@link write} calls.
     * Best-effort — implementations should never throw.
     */
    cleanup(): Promise<void>;
}

// ── Local filesystem implementation ──

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
 * Creates a {@link FileResolver} that writes to `os.tmpdir()` and returns
 * `file:` URLs.
 */
export function createLocalFileResolver(): FileResolver
{
    const written: string[] = [];

    return {
        async write(data, mediaType)
        {
            const ext = extensionForMediaType(mediaType);
            const filename = `codex-ai-sdk-${randomUUID()}${ext}`;
            const filepath = join(tmpdir(), filename);

            const buffer = typeof data === "string"
                ? Buffer.from(data, "base64")
                : data;

            await writeFile(filepath, buffer);
            written.push(filepath);
            return pathToFileURL(filepath);
        },

        async cleanup()
        {
            await Promise.allSettled(written.map((p) => unlink(p)));
            written.length = 0;
        },
    };
}
