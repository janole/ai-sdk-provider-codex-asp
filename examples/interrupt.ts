/**
 * Mid-turn interrupt via onSessionCreated.
 *
 * Starts a streaming turn with a deliberately long task, then interrupts
 * after a delay. Verifies the stream ends with finishReason "other"
 * (mapped from the server's "interrupted" status).
 *
 * Run with:
 *   npx tsx examples/interrupt.ts
 */

import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
    onSessionCreated: (session) =>
    {
        console.log(`[session] created — thread=${session.threadId} turn=${String(session.turnId)}\n`);

        // Interrupt after a short delay to let some output arrive
        setTimeout(() =>
        {
            console.log("\n[interrupt] requesting turn interrupt…\n");
            void session.interrupt();
        }, 5000);
    },
});

const result = streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Write a very detailed, step-by-step guide to building a REST API in Node.js with Express. Cover routing, middleware, error handling, authentication, database integration, testing, and deployment.",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

const finishReason = await result.finishReason;
console.log(`\n[result] finishReason = ${finishReason}`);
console.log(`[verify] interrupted = ${finishReason === "other" ? "YES" : "NO"}`);

await codex.shutdown();
