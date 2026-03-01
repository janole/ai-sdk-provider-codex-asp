import { randomUUID } from "node:crypto";
import { unlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Writes binary data to a temporary file and returns its absolute path.
 *
 * @param data - Raw bytes or a base64-encoded string.
 * @param mediaType - MIME type used to derive the file extension.
 */
export async function writeTempFile(
    data: Uint8Array | string,
    mediaType: string,
): Promise<string>
{
    const ext = extensionForMediaType(mediaType);
    const filename = `codex-ai-sdk-${randomUUID()}${ext}`;
    const filepath = join(tmpdir(), filename);

    const buffer = typeof data === "string"
        ? Buffer.from(data, "base64")
        : data;

    await writeFile(filepath, buffer);
    return filepath;
}

/**
 * Best-effort cleanup of temporary files.  Never throws.
 */
export async function cleanupTempFiles(paths: string[]): Promise<void>
{
    await Promise.allSettled(paths.map((p) => unlink(p)));
}
