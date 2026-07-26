/**
 * Repro: Code Mode (gpt-5.6-sol) abandons a slow host tool instead of waiting for it.
 *
 * A dynamic tool's handler deliberately delays — simulating a human approval that
 * takes minutes. `toolTimeoutMs` is set LONGER than the delay, so *our adapter*
 * waits patiently; any give-up you observe is the MODEL's own Code Mode
 * wait/terminate, not a timeout on our side.
 *
 *   - gpt-5.6-sol (Code Mode)  → invokes the tool inside an `exec` cell, polls it,
 *                                then terminates and works around it after ~minutes.
 *   - gpt-5.5 / gpt-5.4 / ...  → calls the tool directly; the turn suspends until
 *                                the host responds (an approval can sit indefinitely).
 *
 * Run:
 *   npx tsx examples/slow-approval-inline.ts                  # gpt-5.6-sol, 5 min → expect ABANDON
 *   MODEL=gpt-5.5 npx tsx examples/slow-approval-inline.ts    # direct calls → expect WAIT (works)
 *   DELAY_MS=120000 npx tsx examples/slow-approval-inline.ts  # shorter delay
 *   DEBUG_PACKETS=1 npx tsx examples/slow-approval-inline.ts  # also print the exec-cell / turn packets
 *
 * The timestamped log is attachable to an openai/codex issue if it still abandons.
 */

import { streamText } from "ai";

import { createCodexAppServer } from "../src/provider";

const MODEL = process.env.MODEL ?? "gpt-5.6-sol";
const DELAY_MS = Number(process.env.DELAY_MS ?? 5 * 60_000);
const TOOL_TIMEOUT_MS = DELAY_MS + 120_000;
const DEBUG_PACKETS = process.env.DEBUG_PACKETS === "1";

const t0 = Date.now();
const elapsed = (): string => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...args: unknown[]): void => console.log(elapsed().padStart(9), ...args);

let handlerResolved = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined
{
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

/** Surfaces the high-signal codex packets: exec cells, our tool call, and turn end. */
function summarize(packet: { direction: "inbound" | "outbound"; message: unknown }): void
{
    const message = asRecord(packet.message);
    const method = typeof message?.method === "string" ? message.method : undefined;

    if (!method)
    {
        return;
    }

    const params = asRecord(message?.params);
    const item = asRecord(params?.item);
    const itemType = typeof item?.type === "string" ? item.type : undefined;

    if (method === "item/started" && itemType === "commandExecution")
    {
        const command = typeof item?.command === "string" ? item.command : "";
        log(`  [codex] exec cell started: ${command.slice(0, 90)}`);
    }
    else if (method === "item/started" && itemType === "dynamicToolCall")
    {
        log(`  [codex] dynamicToolCall started: ${String(item?.tool)}`);
    }
    else if (method === "turn/completed")
    {
        const turn = asRecord(params?.turn);
        log(`  [codex] TURN COMPLETED (status=${String(turn?.status)})`);
    }
}

const codex = createCodexAppServer({
    experimentalApi: true,
    // Adapter waits longer than the handler → isolates the model's own behavior.
    toolTimeoutMs: TOOL_TIMEOUT_MS,
    debug: {
        logToolCalls: true,
        toolLogger: (event) => log("[adapter]", event.event),
        ...(DEBUG_PACKETS ? { logPackets: true, logger: summarize } : {}),
    },
    tools: {
        provision_workspace: {
            description:
                "Provision an isolated build workspace and return its path. This is a slow, blocking "
                + "setup that waits on a human approval and may take several minutes. You MUST await its "
                + "result and use the real path it returns — do not give up, poll around it, or work around it.",
            inputSchema: {
                type: "object",
                properties: { name: { type: "string", description: "Workspace name." } },
                required: ["name"],
            },
            execute: async (args) =>
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
                log("[handler] approval granted → returning success to Codex");

                const name = (args as { name?: string }).name ?? "demo";
                return {
                    success: true,
                    contentItems: [{ type: "inputText" as const, text: `Workspace '${name}' provisioned at /tmp/${name}.` }],
                };
            },
        },
    },
});

log(`model=${MODEL}  approvalDelay=${(DELAY_MS / 1000).toFixed(0)}s  adapterToolTimeout=${(TOOL_TIMEOUT_MS / 1000).toFixed(0)}s`);
log("starting turn — asking Codex to provision a workspace and wait for it\n");

const result = streamText({
    model: codex(MODEL),
    prompt:
        "Provision a workspace named 'demo' by calling the provision_workspace tool, then report the exact path it returns. "
        + "The tool is slow because it waits on a human approval — you MUST wait for it to finish and use its real result. Do not give up.",
});

for await (const chunk of result.textStream)
{
    process.stdout.write(chunk);
}

const finishReason = await result.finishReason;
log("");
log(`stream finished (finishReason=${finishReason})`);
log("=== VERDICT ===");

if (handlerResolved)
{
    log("WAIT (works / fixed on this model): the turn used the tool's real result — the model waited for the host.");
}
else
{
    log("ABANDON (bug present): the turn ended BEFORE the tool handler resolved — the model gave up on the pending host tool.");
    log(`  model patience ≈ ${elapsed()}; the handler was still waiting on its ${(DELAY_MS / 1000).toFixed(0)}s 'approval'.`);
}

if (heartbeat)
{
    clearInterval(heartbeat);
}
await codex.shutdown();
process.exit(0);
