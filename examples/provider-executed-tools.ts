/**
 * Test that provider-executed tool calls (commandExecution, etc.)
 * pass through streamText without errors.
 *
 * Codex runs commands server-side and emits tool-call / tool-result
 * stream parts with providerExecuted: true. The AI SDK should accept
 * these without requiring the tool to be registered in the tools config.
 *
 * Run with:
 *   npx tsx examples/provider-executed-tools.ts
 */

import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
});

// Intentionally NO tools registered — provider-executed tool calls
// (commandExecution) should pass through without "unavailable tool" errors.
const result = streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Run `echo hello` in the terminal and tell me the output.",
});

console.log("Streaming fullStream (all parts):\n");

for await (const part of result.fullStream)
{
    if (part.type === "text-delta")
    {
        process.stdout.write(part.text);
    }
    else if (part.type === "tool-call")
    {
        console.log(`\n[tool-call] ${part.toolName} (id: ${part.toolCallId})`);
        console.log(`  input: ${JSON.stringify(part.input)}`);
    }
    else if (part.type === "tool-result")
    {
        console.log(`[tool-result] ${part.toolName} (id: ${part.toolCallId})`);
        console.log(`  output: ${JSON.stringify(part.output)}`);
    }
    else if (part.type === "tool-error")
    {
        console.error(`\n[tool-error] ${part.toolName} (id: ${part.toolCallId})`);
        console.error(`  error: ${JSON.stringify(part.error)}`);
    }
    else if (part.type === "error")
    {
        console.error(`\n[ERROR] ${JSON.stringify(part.error)}`);
    }
    else if (part.type === "finish")
    {
        console.log(`\n[finish] reason: ${part.finishReason}`);
        console.log(`  usage: ${JSON.stringify(part.totalUsage)}`);
    }
    else
    {
        console.log(`[${part.type}]`);
    }
}

console.log("\nDone.");
await codex.shutdown();
