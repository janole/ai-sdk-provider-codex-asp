import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const codex = createCodexAppServer({
    defaultModel: "gpt-5.3-codex",
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
    model: codex("gpt-5.3-codex"),
    prompt: "Create a file called /tmp/codex-approval-test.txt with the content 'hello from codex', then delete it again. Confirm both actions were successful.",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

console.log("\n");
