import { streamText } from "ai";

import { createCodexAppServer } from "./provider";

const codex = createCodexAppServer({
    // Enable experimental API (required for dynamicTools)
    experimentalApi: true,

    // Register your tool handlers
    toolHandlers: {
        lookup_ticket: async (args, context) =>
        {
            const id = (args as { id?: string }).id ?? "unknown";
            console.log(`[${context.threadId}] Looking up ticket: ${id}`);

            return {
                success: true,
                contentItems: [{
                    type: "inputText",
                    text: `Ticket ${id} is open and assigned to team Alpha.`,
                }],
            };
        },

        check_weather: async (args, context) =>
        {
            const location = (args as { location?: string }).location ?? "unknown";
            console.log(`[${context.turnId}] Checking weather in: ${location}`);

            return {
                success: true,
                contentItems: [{
                    type: "inputText",
                    text: `Weather in ${location}: 22°C, sunny ☀️`,
                }],
            };
        },
    },

    // Optional: set timeout for tool execution (default: 30s)
    toolTimeoutMs: 30000,

    clientInfo: { name: "@janole/codex-ai-sdk-provider", version: "0.1.0" },
});

// Codex can now call these tools during generation
const result = await streamText({
    model: codex("gpt-5.3-codex"),
    prompt: "Can you check ticket 15 with the lookup_ticket tool?",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}
