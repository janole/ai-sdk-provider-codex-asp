/**
 * Demonstrates AI SDK native cross-call tools with the Codex provider.
 *
 * Same lookup_ticket / check_weather idea as dynamic-tools.ts, but using
 * the standard AI SDK `tool()` helper passed to `streamText({ tools })`.
 * The AI SDK handles execution locally and feeds results back to Codex
 * via the cross-call mechanism (requires persistent transport).
 *
 * Run with:
 *   npx tsx examples/cross-call-tools.ts
 */

import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    persistent: { scope: "global", poolSize: 1, idleTimeoutMs: 60_000 },
    clientInfo: { name: "@janole/codex-ai-sdk-provider", version: "0.1.0" },
});

const result = streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Can you check ticket 15 and also the weather in Berlin?",
    tools: {
        lookup_ticket: tool({
            description: "Look up the current status of a support ticket by its ID.",
            inputSchema: z.object({
                id: z.string().describe("The ticket ID, e.g. \"TICK-42\"."),
            }),
            execute: ({ id }: { id: string }) =>
            {
                console.log(`\n[tool] Looking up ticket: ${id}`);
                return Promise.resolve(`Ticket ${id} is open and assigned to team Alpha.`);
            },
        }),

        check_weather: tool({
            description: "Get the current weather for a given location.",
            inputSchema: z.object({
                location: z.string().describe("City name or coordinates."),
            }),
            execute: ({ location }: { location: string }) =>
            {
                console.log(`\n[tool] Checking weather in: ${location}`);
                return Promise.resolve(`Weather in ${location}: 22°C, sunny`);
            },
        }),
    },
    stopWhen: stepCountIs(5),
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

console.log("\n");
await codex.shutdown();
