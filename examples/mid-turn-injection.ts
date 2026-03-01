/**
 * Mid-turn message injection via onSessionCreated.
 *
 * Starts a streaming turn, then injects a follow-up instruction while
 * the turn is still in progress using session.injectMessage().
 *
 * Run with:
 *   npx tsx examples/mid-turn-injection.ts
 */

import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
    onSessionCreated: (session) =>
    {
        console.log(`\n[session] created — thread=${session.threadId} turn=${String(session.turnId)}\n`);

        // Inject a follow-up instruction while the turn is still in progress
        void session.injectMessage("Also add input validation and JSDoc comments.");
        console.log("[inject] sent follow-up instruction\n");
    },
});

const result = streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Write a short TypeScript function that adds two numbers.",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

console.log("\n");
await codex.shutdown();
