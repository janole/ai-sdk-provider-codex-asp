/**
 * Thread continuation via response.messages.
 *
 * Turn 1 — tells Codex a secret number.
 * Turn 2 — asks Codex to recall it. The threadId flows automatically
 *           through response.messages (providerMetadata), so the
 *           provider calls thread/resume instead of thread/start.
 *
 * Run with:
 *   npx tsx examples/thread-continuation.ts
 */

import { generateText, type ModelMessage } from "ai";

import { CODEX_PROVIDER_ID } from "../src";
import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});

const model = codex.languageModel("gpt-5.3-codex");
const messages: ModelMessage[] = [];

// ── Turn 1 ──────────────────────────────────────────────────────────────────

console.log("Turn 1: sharing a secret number…\n");

messages.push({ role: "user", content: "My secret number is 42. Please confirm you have noted it." });

const turn1 = await generateText({ model, messages });

console.log("Codex:", turn1.text);

const threadId = turn1.providerMetadata?.[CODEX_PROVIDER_ID]?.["threadId"];
console.log("\nThread ID:", threadId);

// Append the full response messages — they carry the threadId in providerMetadata
messages.push(...turn1.response.messages);

// ── Turn 2 ──────────────────────────────────────────────────────────────────

console.log("\nTurn 2: asking Codex to recall the number…\n");

messages.push({ role: "user", content: "What was my secret number?" });

const turn2 = await generateText({ model, messages });

console.log("Codex:", turn2.text);

await codex.shutdown();
