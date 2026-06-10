/**
 * Per-call provider options — override settings like `cwd` and `effort`
 * on each streamText() / generateText() call without recreating the provider.
 *
 * Run with:
 *   npx tsx examples/per-call-options.ts
 */

import { streamText } from "ai";

import { codexCallOptions } from "../src/protocol/provider-metadata";
import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.5",
    defaultTurnSettings: {
        effort: "low",
    },
});

// First call — uses provider defaults (effort: "low")
const result1 = streamText({
    model: codex("gpt-5.5"),
    prompt: "What directory am I in?",
});

for await (const chunk of result1.textStream)
{
    process.stdout.write(chunk);
}
console.log("\n");

// Second call — overrides cwd and effort for this call only
const result2 = streamText({
    model: codex("gpt-5.5"),
    prompt: "What directory am I in now? Summarize this project briefly.",
    providerOptions: codexCallOptions({
        cwd: "/tmp",
        effort: "high",
    }),
});

for await (const chunk of result2.textStream)
{
    process.stdout.write(chunk);
}
console.log("\n");

await codex.shutdown();
