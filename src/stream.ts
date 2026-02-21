import type { CodexStreamChunk } from "./types";

/**
 * Placeholder stream implementation for Codex protocol responses.
 *
 * This async generator currently emits a single `done` chunk so the
 * scaffold has a stable, typed streaming surface.
 */
export async function* createCodexStream(): AsyncGenerator<CodexStreamChunk> 
{
    await Promise.resolve();
    yield { type: "done" };
}
