/**
 * Command and file-change approval handling.
 *
 * Registers approval handlers that auto-accept all requests.
 * Both approval callbacks receive the raw generated Codex protocol request objects.
 * In production you'd prompt the user or apply policy checks.
 *
 * Run with:
 *   npx tsx examples/approvals.ts
 */

import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.5",
    approvals: {
        onCommandApproval: (req) =>
        {
            console.log(`\n[APPROVAL] Command: ${req.command}`);
            console.log(`[APPROVAL]     cwd: ${req.cwd}`);
            console.log("[APPROVAL] → auto-accepting\n");
            return "accept";
        },
        onFileChangeApproval: (req) =>
        {
            console.log("\n[APPROVAL] File change requested");
            if (req.reason)
            {
                console.log(`[APPROVAL]  reason: ${req.reason}`);
            }
            console.log("[APPROVAL] → auto-accepting\n");
            return "accept";
        },
    },
});

const result = streamText({
    model: codex("gpt-5.5"),
    prompt: "Create a file called /tmp/codex-approval-test.txt with the content 'hello from codex', then delete it again. Confirm both actions were successful.",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

console.log("\n");
await codex.shutdown();
