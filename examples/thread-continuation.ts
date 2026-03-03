/**
 * Thread continuation across provider restarts.
 *
 * Turn 1 — tells Codex a secret number.
 * Turn 2 — after a full shutdown/restart, asks Codex to recall it.
 *
 * The provider embeds the threadId in providerMetadata on response
 * content parts. Passing response.messages back is enough for the
 * provider to detect the threadId and call thread/resume.
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

const rawThreadId = turn1.providerMetadata?.[CODEX_PROVIDER_ID]?.["threadId"];
const threadId = typeof rawThreadId === "string" ? rawThreadId : undefined;
console.log("\nThread ID:", threadId);

// Append response messages — content parts now carry providerMetadata with
// the threadId, so the provider picks it up automatically on the next call.
messages.push(...turn1.response.messages);

// ── Restart provider (simulates process restart) ─────────────────────────────

console.log("\nShutting down provider…");
await codex.shutdown();

const codex2 = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});
const model2 = codex2.languageModel("gpt-5.3-codex");
console.log("Provider restarted.\n");

// ── Turn 2 ──────────────────────────────────────────────────────────────────

console.log("Turn 2: asking Codex to recall the number…\n");

messages.push({ role: "user", content: "What was my secret number?" });

const turn2 = await generateText({ model: model2, messages });

console.log("Codex:", turn2.text);

const rawThreadId2 = turn2.providerMetadata?.[CODEX_PROVIDER_ID]?.["threadId"];
const threadId2 = typeof rawThreadId2 === "string" ? rawThreadId2 : undefined;
console.log("\nThread ID:", threadId2);

if (threadId && threadId2 && threadId === threadId2)
{
    console.log("\n✓ Same threadId across restart — thread continuation works!");
}
else
{
    console.log(`\n✗ ThreadId mismatch: turn1=${String(threadId)}, turn2=${String(threadId2)}`);
}

await codex2.shutdown();
