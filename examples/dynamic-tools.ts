/**
 * Demonstrates provider-level dynamic tools with inline execution.
 *
 * Tools are registered on the provider with full schema + execute handlers.
 * When Codex calls a tool, the provider executes the handler inline and
 * returns the result within the same turn — no cross-call needed.
 *
 * Requires experimentalApi: true (Codex feature flag for dynamicTools).
 *
 * Run with:
 *   npx tsx examples/dynamic-tools.ts
 */

import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    // Enable experimental API (required for dynamicTools)
    experimentalApi: true,

    // Register tools with full schema — advertised to Codex so it knows how to call them
    tools: {
        lookup_ticket: {
            description: "Look up the current status of a support ticket by its ID.",
            inputSchema: {
                type: "object",
                properties: {
                    id: { type: "string", description: "The ticket ID, e.g. \"TICK-42\"." },
                },
                required: ["id"],
            },
            execute: (args, context) =>
            {
                const id = (args as { id?: string }).id ?? "unknown";
                console.log(`[${context.threadId}] Looking up ticket: ${id}`);

                return Promise.resolve({
                    success: true,
                    contentItems: [{
                        type: "inputText" as const,
                        text: `Ticket ${id} is open and assigned to team Alpha.`,
                    }],
                });
            },
        },

        check_weather: {
            description: "Get the current weather for a given location.",
            inputSchema: {
                type: "object",
                properties: {
                    location: { type: "string", description: "City name or coordinates." },
                },
                required: ["location"],
            },
            execute: (args, context) =>
            {
                const location = (args as { location?: string }).location ?? "unknown";
                console.log(`[${context.turnId}] Checking weather in: ${location}`);

                return Promise.resolve({
                    success: true,
                    contentItems: [{
                        type: "inputText" as const,
                        text: `Weather in ${location}: 22°C, sunny`,
                    }],
                });
            },
        },
    },

    // Optional: set timeout for tool execution (default: 30s)
    toolTimeoutMs: 30000,

    clientInfo: { name: "@janole/ai-sdk-provider-codex-asp", version: "0.1.0" },
});

// Codex can now call these tools during generation
const result = streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Can you check ticket 15 and also the weather in Berlin?",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

console.log("\n");
await codex.shutdown();
