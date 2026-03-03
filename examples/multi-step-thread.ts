/**
 * Multi-step thread continuation test.
 *
 * Verifies that threadId flows correctly across AI SDK internal steps
 * (maxSteps > 1). The model must call a tool in step 1, receive the
 * result in step 2, and produce a final answer — all on the same
 * Codex thread.
 *
 * Run with:
 *   npx tsx examples/multi-step-thread.ts
 */

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

import { CODEX_PROVIDER_ID } from "../src";
import { createCodexAppServer } from "../src/provider";

let threadId: string | undefined;

const codex = createCodexAppServer({
    persistent: { scope: "global", poolSize: 1, idleTimeoutMs: 60_000 },
    debug: {
        logPackets: true,
        logger: ({ message }: { message: any }) =>
        {
            if (!threadId)
            {
                threadId = message?.params?.threadId;
            }

            if (message?.params?.threadId && message?.params?.threadId != threadId)
            {
                console.error("ERROR: threadId mismatch", threadId, message);
            }
        },
    }
});

const model = codex("gpt-5.3-codex");

// ── Multi-step call: tool use + follow-up in one generateText call ──────────

console.log("Starting multi-step call (maxSteps: 5)…\n");

const result = await generateText({
    model,
    prompt: "What is the current status of ticket TICK-99? Summarize it for me.",
    tools: {
        lookup_ticket: tool({
            description: "Look up the current status of a support ticket by its ID.",
            inputSchema: z.object({
                id: z.string().describe("The ticket ID, e.g. \"TICK-99\"."),
            }),
            execute: ({ id }: { id: string }) =>
            {
                console.log(`  [tool] lookup_ticket called with id: ${id}`);
                return Promise.resolve(
                    `Ticket ${id}: status=open, priority=high, assigned to backend team. ` +
                    `Customer reports intermittent 503 errors on /api/checkout since Monday.`,
                );
            },
        }),
    },
    stopWhen: stepCountIs(5),
});

console.log(`\nCompleted in ${result.steps.length} step(s).`);
console.log(`Final text: ${result.text}\n`);

// Check that threadId was consistent across steps
const threadIds = result.steps
    .map((step, i) =>
    {
        const tid = step.providerMetadata?.[CODEX_PROVIDER_ID]?.["threadId"];
        console.log(`  Step ${i + 1} threadId: ${tid ?? "(none)"}`);
        return tid;
    })
    .filter(Boolean);

const uniqueThreadIds = new Set(threadIds);

if (uniqueThreadIds.size === 1)
{
    console.log(`\n✓ All steps used the same threadId: ${[...uniqueThreadIds][0]}`);
}
else if (uniqueThreadIds.size === 0)
{
    console.log("\n✗ No threadId found in any step.");
}
else
{
    console.log(`\n✗ Multiple threadIds found across steps: ${[...uniqueThreadIds].join(", ")}`);
}

await codex.shutdown();
