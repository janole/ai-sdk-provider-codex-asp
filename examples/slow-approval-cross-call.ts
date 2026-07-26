/**
 * Repro (cross-call flavour): the same slow-host-tool abandonment, but through the
 * AI SDK cross-call path — the exact shape an embedding host (e.g. botbandit) uses.
 *
 * A standard AI SDK `tool()` whose `execute` deliberately delays (simulating a human
 * approval). The provider parks the call on the persistent worker across steps.
 *
 *   - gpt-5.6-sol (Code Mode)  → wraps the call in an `exec` cell, polls it, and ends
 *                                the turn before the host answers. When our delayed
 *                                result finally lands, the turn is gone; the provider's
 *                                abandon backstop (PR #75) surfaces an "Approval
 *                                interrupted" tool-result instead of hanging.
 *   - gpt-5.5 / gpt-5.4 / ...  → direct call; the turn suspends until execute resolves.
 *
 * Run:
 *   npx tsx examples/slow-approval-cross-call.ts                 # gpt-5.6-sol, 5 min → expect INTERRUPTED
 *   MODEL=gpt-5.5 npx tsx examples/slow-approval-cross-call.ts   # direct → expect the real result used
 *   DELAY_MS=120000 npx tsx examples/slow-approval-cross-call.ts # shorter delay
 */

import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import { createCodexAppServer } from "../src/provider";

const MODEL = process.env.MODEL ?? "gpt-5.6-sol";
const DELAY_MS = Number(process.env.DELAY_MS ?? 5 * 60_000);

const t0 = Date.now();
const elapsed = (): string => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...args: unknown[]): void => console.log(elapsed().padStart(9), ...args);

let handlerResolved = false;
let sawInterrupted = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;

const codex = createCodexAppServer({
    persistent: { scope: "global", poolSize: 1, idleTimeoutMs: 600_000 },
});

const result = streamText({
    model: codex(MODEL),
    prompt:
        "Provision a workspace named 'demo' by calling provision_workspace, then report the exact path it returns. "
        + "The tool is slow because it waits on a human approval — you MUST wait for its real result. Do not give up.",
    stopWhen: stepCountIs(3),
    tools: {
        provision_workspace: tool({
            description:
                "Provision an isolated build workspace and return its path. Slow, blocking, waits on a "
                + "human approval (may take several minutes). You MUST await its real result — do not give up.",
            inputSchema: z.object({ name: z.string().describe("Workspace name.") }),
            execute: async ({ name }: { name: string }) =>
            {
                const calledAt = Date.now();
                log(`[handler] provision_workspace CALLED — simulating a ${(DELAY_MS / 1000).toFixed(0)}s human approval …`);
                heartbeat = setInterval(
                    () => log(`[handler] …still awaiting approval (${((Date.now() - calledAt) / 1000).toFixed(0)}s elapsed)`),
                    30_000,
                );

                await new Promise((resolve) => setTimeout(resolve, DELAY_MS));

                if (heartbeat)
                {
                    clearInterval(heartbeat);
                }
                handlerResolved = true;
                log("[handler] approval granted → returning the real result to the AI SDK");
                return `Workspace '${name}' provisioned at /tmp/${name}.`;
            },
        }),
    },
});

log(`model=${MODEL}  approvalDelay=${(DELAY_MS / 1000).toFixed(0)}s`);
log("starting turn — cross-call path (persistent transport)\n");

interface StreamView { type: string; text?: string; toolName?: string; finishReason?: string; error?: unknown }

for await (const raw of result.fullStream)
{
    const part = raw as StreamView;

    if (part.type === "text-delta")
    {
        process.stdout.write(part.text ?? "");
    }
    else if (part.type === "tool-call")
    {
        log(`[stream] tool-call → ${part.toolName}`);
    }
    else if (part.type === "tool-result")
    {
        const interrupted = JSON.stringify(raw).includes("Approval interrupted");
        sawInterrupted ||= interrupted;
        log(`[stream] tool-result ← ${part.toolName}${interrupted ? "  (INTERRUPTED — adapter #75 backstop fired)" : ""}`);
    }
    else if (part.type === "finish")
    {
        log(`[stream] finish (${part.finishReason})`);
    }
    else if (part.type === "error")
    {
        log("[stream] error", part.error);
    }
}

log("");
log("=== VERDICT ===");

if (sawInterrupted)
{
    log("ABANDON (bug present): the model ended the turn before the host answered; the provider surfaced an interrupted result (no hang, but the call was not honoured).");
}
else if (handlerResolved)
{
    log("WAIT (works / fixed on this model): the turn used the tool's real result — the model waited for the host.");
}
else
{
    log("INCONCLUSIVE: the stream ended without a resolved handler or an interrupted result — inspect the log above.");
}

if (heartbeat)
{
    clearInterval(heartbeat);
}
await codex.shutdown();
process.exit(0);
