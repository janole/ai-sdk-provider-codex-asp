/**
 * Streaming text generation with streamText().
 *
 * Run with:
 *   npx tsx examples/stream-text.ts
 */

import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.6-sol",
});

const result = streamText({
    model: codex("gpt-5.6-sol"),
    prompt: "Check the local repository just quickly. What it is about?",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

console.log("\n");
await codex.shutdown();
