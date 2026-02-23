/**
 * Demonstrates thread continuation via providerMetadata.
 *
 * Turn 1 — tells Codex a secret number.
 * Turn 2 — asks Codex to recall it, using thread/resume so no history is re-sent.
 *
 * Run with:
 *   npx tsx examples/thread-continuation.ts
 */

import { generateText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});

const model = codex.languageModel("gpt-5.3-codex");

// ── Turn 1 ──────────────────────────────────────────────────────────────────

console.log("Turn 1: sharing a secret number…\n");

const turn1 = await generateText({
    model,
    messages: [
        {
            role: "user",
            content: "My secret number is 42. Please confirm you have noted it.",
        },
    ],
});

console.log("Codex:", turn1.text);

const threadId = turn1.providerMetadata?.["codex-app-server"]?.["threadId"];
console.log("\nThread ID:", threadId, "\n");

if (!threadId || typeof threadId !== "string")
{
    throw new Error("No threadId in providerMetadata — thread continuation unavailable.");
}

// ── Turn 2 ──────────────────────────────────────────────────────────────────

console.log("Turn 2: asking Codex to recall the number…\n");

const turn2 = await generateText({
    model,
    messages: [
        {
            role: "user",
            content: "My secret number is 42. Please confirm you have noted it.",
        },
        {
            role: "assistant",
            content: turn1.text,
            // Carry the threadId forward so the provider calls thread/resume
            // instead of thread/start, and sends only the new user message.
            providerOptions: {
                "codex-app-server": { threadId },
            },
        },
        {
            role: "user",
            content: "What was my secret number?",
        },
    ],
});

console.log("Codex:", turn2.text);
