/**
 * Probes how a running Codex turn can move to another working directory. Live model calls
 * against the real `codex` binary; nothing is mocked.
 *
 * A dynamic tool `switch_workspace` stands in for the consumer's "change directory" tool. Each
 * scenario starts a native turn in workspace A, lets the model call the tool, applies one
 * candidate mechanism, and then records where the model's later shell commands actually ran:
 * the `cwd` Codex reports for each command, the files that commands wrote relative to their
 * working directory, and whether a write to the old workspace is denied by the sandbox.
 *
 * Scenarios (run all, or name some on the command line):
 *   inplace-sequential  turn/settings/update + thread/settings/update `environments`, one call per step
 *   inplace-parallel    the same, with a native command in the same tool batch as the switch
 *   gated-parallel      inplace-parallel under `untrusted`, declining command approvals while the
 *                       switch is pending (the only client-side hook on native execution)
 *   steer               active-turn `turn/start` with cwd overrides (expected: steers input only)
 *   boundary-parallel   interrupt the turn while the switch is pending, then `turn/start` with
 *                       `toolOutput` and the new context
 *   concurrent          inplace-sequential on two threads of one app-server at the same time
 *   adapter-crosscall   inplace-sequential through the adapter's CodexSession.moveExecutionContext,
 *                       from an AI SDK tool that runs between cross-call steps (persistent pool)
 *   adapter-dynamic     the same from a provider-executed dynamic tool, which runs inside the step
 *
 * Needs codex >= 0.169 (environments on the settings APIs) and a logged-in `codex`.
 * Workspaces live under the home directory, not TMPDIR: workspace-write always allows TMPDIR
 * and /tmp, which would hide whether the sandbox follows the move.
 *
 * Run with:
 *   CODEX_BIN=/path/to/codex npx tsx scripts/context-handoff-probe.ts [scenario...]
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return --
 * A diagnostic probe that logs raw app-server wire JSON across many message shapes; typing each
 * shape would add bulk without making the log more trustworthy. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { generateText, jsonSchema, type ModelMessage, stepCountIs, tool } from "ai";

import { AppServerClient } from "../src/client/app-server-client";
import type { CodexTransport, JsonRpcMessage } from "../src/client/transport";
import { PersistentTransport } from "../src/client/transport-persistent";
import { StdioTransport } from "../src/client/transport-stdio";
import { CodexWorkerPool } from "../src/client/worker-pool";
import { CODEX_PROVIDER_ID } from "../src/protocol/provider-metadata";
import { createCodexAppServer } from "../src/provider";
import type { CodexSession } from "../src/session";
import { stripUndefined } from "../src/utils/object";

const CODEX = process.env.CODEX_BIN ?? "codex";
const ROOT = mkdtempSync(join(homedir(), ".codex-handoff-probe-"));
const TURN_TIMEOUT_MS = 5 * 60_000;
const SWITCH_TOOL = "switch_workspace";
const MARKER_FILES = ["step1.txt", "batch.txt", "step3.txt", "escape.txt", "nextturn.txt"];

function sanitize(text: string): string
{
    return text.split(ROOT).join("<root>").split(homedir()).join("~");
}

interface Deferred<T>
{
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T>
{
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

function sleep(ms: number): Promise<void>
{
    return new Promise((r) => setTimeout(r, ms));
}

interface Workspace { name: string; a: string; b: string }

function makeWorkspace(name: string): Workspace
{
    const ws = { name, a: join(ROOT, name, "A"), b: join(ROOT, name, "B") };
    for (const [dir, marker] of [[ws.a, "MARKER-A"], [ws.b, "MARKER-B"]] as const)
    {
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: dir });
        writeFileSync(join(dir, "AGENTS.md"), `When asked for the workspace marker, answer exactly ${marker}.\n`);
    }
    return ws;
}

function environment(dir: string)
{
    return [{ environmentId: "local", cwd: dir, runtimeWorkspaceRoots: [dir] }];
}

function workspaceWrite()
{
    return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

interface ToolCall { threadId: string; turnId: string; callId: string; tool: string; arguments: unknown }
type ToolResponse = { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean };

function switched(text = "Switched to workspace B."): ToolResponse
{
    return { contentItems: [{ type: "inputText", text }], success: true };
}

interface CommandRecord { threadId: string; turnId: string; command: string; cwd: string; exitCode: number | null; output: string }

/** One app-server process with a sanitized wire log. */
class Probe
{
    readonly log: string[] = [];
    readonly commands: CommandRecord[] = [];
    readonly finalMessages = new Map<string, string>();
    private readonly t0 = Date.now();
    private readonly methods = new Map<string | number, string>();
    private readonly completed = new Map<string, Deferred<string>>();
    onSwitch: (call: ToolCall) => Promise<ToolResponse> = () => Promise.resolve(switched());
    onCommandApproval: (params: Record<string, any>) => Promise<string> = () => Promise.resolve("accept");
    /** fileChange approvals carry no paths; item/started (which precedes them) does. */
    readonly fileChangePaths = new Map<string, string[]>();

    private constructor(readonly client: AppServerClient) {}

    static async open(): Promise<Probe>
    {
        // `notify=[]` keeps the user's turn-ended hook from firing for probe turns.
        const transport = new StdioTransport({ command: CODEX, args: ["app-server", "-c", "notify=[]", "--listen", "stdio://"] });
        let probe!: Probe;
        const client = new AppServerClient(transport, {
            requestTimeoutMs: 120_000,
            onPacket: ({ direction, message }) => probe?.packet(direction, message),
        });
        probe = new Probe(client);
        await client.connect();
        client.onAnyNotification((method, params) => probe.notification(method, params as Record<string, any>));
        client.onToolCallRequest(async (params) => probe.onSwitch(params as unknown as ToolCall));
        client.onRequest("item/commandExecution/requestApproval", async (params) =>
        {
            const decision = await probe.onCommandApproval(params as Record<string, any>);
            return { decision };
        });
        client.onRequest("item/fileChange/requestApproval", async (params) =>
        {
            const decision = await probe.onCommandApproval({ ...(params as Record<string, any>), fileChange: true });
            return { decision };
        });
        await client.request("initialize", { clientInfo: { name: "context-handoff-probe", version: "0" }, capabilities: { experimentalApi: true } });
        await client.notification("initialized");
        return probe;
    }

    note(line: string): void
    {
        this.log.push(`${String(Date.now() - this.t0).padStart(7)}ms  ${sanitize(line)}`);
    }

    private packet(direction: "inbound" | "outbound", message: JsonRpcMessage): void
    {
        const m = message as Record<string, any>;
        if ("method" in m && "id" in m)
        {
            if (direction === "outbound")
            {
                this.methods.set(m.id, m.method);
            }
            if (m.method === "initialize")
            {
                return;
            }
            const p = m.params ?? {};
            const detail = m.method === "item/tool/call"
                ? `${p.tool} turn=${short(p.turnId)} call=${short(p.callId)}`
                : m.method === "item/fileChange/requestApproval"
                    ? `turn=${short(p.turnId)} item=${short(p.itemId)} grantRoot=${p.grantRoot ?? null}`
                    : m.method === "item/commandExecution/requestApproval"
                        ? `turn=${short(p.turnId)} cwd=${p.cwd} cmd=${JSON.stringify(p.command)}`
                        : summarizeParams(p);
            this.note(`${direction === "outbound" ? "→" : "⇐"} ${m.method} ${detail}`);
        }
        else if ("id" in m && ("result" in m || "error" in m))
        {
            const method = direction === "outbound" ? "server-request response" : this.methods.get(m.id) ?? "?";
            if (method === "initialize")
            {
                return;
            }
            const body = "error" in m ? `ERROR ${JSON.stringify(m.error)}` : summarizeResult(m.result);
            this.note(`${direction === "outbound" ? "→" : "←"} ${method}: ${body}`);
        }
    }

    private notification(method: string, p: Record<string, any>): void
    {
        if (method === "turn/started")
        {
            this.note(`· turn/started thread=${short(p.threadId)} turn=${short(p.turn?.id)}`);
        }
        else if (method === "turn/completed")
        {
            this.note(`· turn/completed turn=${short(p.turn?.id)} status=${p.turn?.status}${p.turn?.error ? ` error=${JSON.stringify(p.turn.error)}` : ""}`);
            this.completedFor(p.turn?.id).resolve(p.turn?.status);
        }
        else if (method === "thread/settings/updated")
        {
            this.note(`· thread/settings/updated cwd=${p.threadSettings?.cwd} environments=${JSON.stringify(p.threadSettings?.environments)}`);
        }
        else if (method === "error")
        {
            this.note(`· error ${JSON.stringify(p)}`);
        }
        else if (method === "serverRequest/resolved")
        {
            this.note(`· serverRequest/resolved ${JSON.stringify(p)}`);
        }
        else if (method === "item/started" || method === "item/completed")
        {
            const item = p.item ?? {};
            const verb = method === "item/started" ? "started" : "completed";
            if (item.type === "commandExecution")
            {
                this.note(`· ${verb} command turn=${short(p.turnId)} cwd=${item.cwd} status=${item.status} cmd=${JSON.stringify(item.command)}`
                    + (verb === "completed" ? ` exit=${item.exitCode} out=${JSON.stringify(trim(item.aggregatedOutput))}` : ""));
                if (verb === "completed")
                {
                    this.commands.push({ threadId: p.threadId, turnId: p.turnId, command: item.command, cwd: item.cwd, exitCode: item.exitCode, output: trim(item.aggregatedOutput) });
                }
            }
            else if (item.type === "dynamicToolCall")
            {
                this.note(`· ${verb} dynamicToolCall turn=${short(p.turnId)} status=${item.status} success=${item.success}`);
            }
            else if (item.type === "fileChange")
            {
                this.fileChangePaths.set(item.id, (item.changes ?? []).map((c: any) => c.path));
                this.note(`· ${verb} fileChange turn=${short(p.turnId)} status=${item.status} paths=${JSON.stringify((item.changes ?? []).map((c: any) => c.path))}`);
            }
            else if (item.type === "functionCallOutput")
            {
                this.note(`· ${verb} functionCallOutput name=${item.name} turn=${short(p.turnId)}`);
            }
            else if (item.type === "agentMessage" && verb === "completed")
            {
                this.finalMessages.set(p.threadId, item.text);
                this.note(`· agentMessage ${JSON.stringify(trim(item.text))}`);
            }
        }
    }

    private completedFor(turnId: string): Deferred<string>
    {
        let entry = this.completed.get(turnId);
        if (!entry)
        {
            entry = deferred<string>();
            this.completed.set(turnId, entry);
        }
        return entry;
    }

    turnCompleted(turnId: string): Promise<string>
    {
        return Promise.race([
            this.completedFor(turnId).promise,
            sleep(TURN_TIMEOUT_MS).then(() => "timeout"),
        ]);
    }

    async startThread(cwd: string, approvalPolicy = "never"): Promise<{ threadId: string; instructionSources: string[] }>
    {
        const result = await this.client.request<{ thread: { id: string }; instructionSources: string[] }>("thread/start", {
            cwd,
            sandbox: "workspace-write",
            approvalPolicy,
            ephemeral: true,
            dynamicTools: [{
                type: "function",
                name: SWITCH_TOOL,
                description: "Moves this session's execution context (working directory and writable workspace) to workspace B. Shell commands issued after this tool returns run in workspace B.",
                inputSchema: { type: "object", properties: { target: { type: "string", enum: ["B"] } }, required: ["target"], additionalProperties: false },
            }],
        });
        return { threadId: result.thread.id, instructionSources: result.instructionSources };
    }

    async startTurn(threadId: string, text: string, extra: Record<string, unknown> = {}): Promise<string>
    {
        const result = await this.client.request<{ turn: { id: string } }>("turn/start", {
            threadId,
            input: text ? [{ type: "text", text, text_elements: [] }] : [],
            ...extra,
        });
        return result.turn.id;
    }

    /** Applies the in-place move: running turn's later steps plus the thread's future turns. */
    async moveInPlace(threadId: string, turnId: string, dir: string): Promise<void>
    {
        await this.client.request("turn/settings/update", { threadId, turnId, environments: environment(dir) });
        await this.client.request("thread/settings/update", { threadId, cwd: dir, environments: environment(dir), sandboxPolicy: workspaceWrite() });
    }

    async close(): Promise<void>
    {
        await this.client.disconnect();
    }
}

function short(id: unknown): string
{
    return typeof id === "string" ? id.slice(-6) : String(id);
}

function trim(text: unknown): string
{
    const s = typeof text === "string" ? text.trim() : "";
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

function summarizeParams(p: Record<string, any>): string
{
    const keep = ["turnId", "expectedTurnId", "cwd", "environments", "runtimeWorkspaceRoots", "sandboxPolicy", "toolOutput", "input"];
    const out: Record<string, unknown> = {};
    for (const key of keep)
    {
        if (p[key] !== undefined)
        {
            out[key] = key === "turnId" ? short(p[key])
                : key === "sandboxPolicy" ? p[key].type
                    : key === "input" ? (p[key] as unknown[]).length
                        : key === "toolOutput" ? p[key]?.name
                            : p[key];
        }
    }
    return JSON.stringify(out);
}

function summarizeResult(result: Record<string, any>): string
{
    if (result?.turn)
    {
        return `turn=${short(result.turn.id)} status=${result.turn.status}`;
    }
    if (result?.thread)
    {
        return `thread=${short(result.thread.id)} cwd=${result.cwd} instructionSources=${JSON.stringify(result.instructionSources)}`;
    }
    return JSON.stringify(result);
}

function files(ws: Workspace): string
{
    const where = (dir: string) => MARKER_FILES
        .filter((f) => existsSync(join(dir, f)))
        .map((f) => `${f}(${readFileSync(join(dir, f), "utf8").trim().split("/").pop()})`)
        .join(" ") || "-";
    return `A: ${where(ws.a)} | B: ${where(ws.b)}`;
}

const SEQUENTIAL = (ws: Workspace) => [
    "This is a protocol probe. Do these steps in order, one tool call per response, waiting for each result:",
    "1. Run the shell command: pwd > step1.txt; pwd",
    `2. Call ${SWITCH_TOOL} with target "B".`,
    "3. Run the shell command: pwd > step3.txt; pwd",
    `4. Run the shell command: echo probe > ${ws.a}/escape.txt; echo exit=$?`,
    "5. Reply with only the workspace marker your project instructions (AGENTS.md) give you now.",
].join("\n");

// BATCH_CMD swaps the native sibling, e.g. a read-only command or an apply_patch edit.
const BATCH_CMD = process.env.BATCH_CMD ?? "pwd > batch.txt; pwd";
const BATCH_CALL = process.env.BATCH_CALL ?? `the shell command: ${BATCH_CMD}`;

const PARALLEL = [
    "This is a protocol probe. Do these steps in order:",
    "1. Run the shell command: pwd > step1.txt; pwd",
    `2. In ONE single response, emit two tool calls in parallel: first ${SWITCH_TOOL} with target "B", then ${BATCH_CALL}`,
    "   Do not wait for the first call before emitting the second.",
    "3. After both return, run the shell command: pwd > step3.txt; pwd",
    "4. Reply DONE.",
].join("\n");

const NEXT_TURN = "Run the shell command: pwd > nextturn.txt; pwd. Then reply with only the workspace marker your project instructions (AGENTS.md) give you now.";

interface Result { name: string; probe: { log: string[]; close(): Promise<void> }; observations: string[] }

async function inPlaceSequential(name = "inplace-sequential", shared?: Probe): Promise<Result>
{
    const probe = shared ?? await Probe.open();
    const ws = makeWorkspace(name);
    const { threadId, instructionSources } = await probe.startThread(ws.a);
    const previous = probe.onSwitch;
    probe.onSwitch = async (call) =>
    {
        if (call.threadId !== threadId)
        {
            return previous(call);
        }
        await probe.moveInPlace(threadId, call.turnId, ws.b);
        return switched();
    };
    const turn1 = await probe.startTurn(threadId, SEQUENTIAL(ws));
    const status1 = await probe.turnCompleted(turn1);
    const turn2 = await probe.startTurn(threadId, NEXT_TURN);
    const status2 = await probe.turnCompleted(turn2);
    return {
        name,
        probe,
        observations: [
            `thread instructionSources at start: ${sanitize(JSON.stringify(instructionSources))}`,
            `turn1=${status1} turn2=${status2}`,
            ...commandLines(probe, threadId),
            `files ${sanitize(files(ws))}`,
            `final message: ${JSON.stringify(probe.finalMessages.get(threadId))}`,
        ],
    };
}

async function inPlaceParallel(): Promise<Result>
{
    const probe = await Probe.open();
    const ws = makeWorkspace("inplace-parallel");
    const { threadId } = await probe.startThread(ws.a);
    probe.onSwitch = async (call) =>
    {
        await probe.moveInPlace(threadId, call.turnId, ws.b);
        // Let the model's stream finish so a sibling call in the batch is queued behind the switch.
        await sleep(4_000);
        return switched();
    };
    const turn1 = await probe.startTurn(threadId, PARALLEL);
    const status1 = await probe.turnCompleted(turn1);
    return { name: "inplace-parallel", probe, observations: [`turn1=${status1}`, ...commandLines(probe, threadId), `files ${sanitize(files(ws))}`] };
}

/**
 * The only client-side hook on native execution is the approval request. Under `untrusted`,
 * the adapter declines every command approval while a switch is pending or whose cwd is not
 * the switch target, and records which commands ran without asking.
 */
async function gatedParallel(): Promise<Result>
{
    const probe = await Probe.open();
    const ws = makeWorkspace("gated-parallel");
    const { threadId } = await probe.startThread(ws.a, "untrusted");
    let pending = false;
    let target = ws.a;
    probe.onCommandApproval = (params) =>
    {
        // Siblings keep the context of the step that emitted them, even when they run after the
        // move is acknowledged, so gate on where the action lands, not only on the pending switch.
        const inside = (path: string) => path === target || path.startsWith(`${target}/`);
        const lands = params.fileChange
            ? (probe.fileChangePaths.get(params.itemId) ?? [""]).every(inside)
            : params.cwd === target;
        const decision = pending || !lands ? "decline" : "accept";
        probe.note(`  gate: ${decision} (pending=${pending}, lands=${lands})`);
        return Promise.resolve(decision);
    };
    probe.onSwitch = async (call) =>
    {
        pending = true;
        await probe.moveInPlace(threadId, call.turnId, ws.b);
        await sleep(4_000);
        target = ws.b;
        pending = false;
        return switched();
    };
    const prompt = PARALLEL.replace("pwd > step1.txt; pwd", "pwd > step1.txt; pwd").concat("\nIf a command is declined, do not retry it.");
    const turn1 = await probe.startTurn(threadId, prompt);
    const status1 = await probe.turnCompleted(turn1);
    return { name: "gated-parallel", probe, observations: [`turn1=${status1}`, ...commandLines(probe, threadId), `files ${sanitize(files(ws))}`] };
}

async function steer(): Promise<Result>
{
    const probe = await Probe.open();
    const ws = makeWorkspace("steer");
    const { threadId } = await probe.startThread(ws.a);
    let steeredTurn = "";
    probe.onSwitch = async () =>
    {
        steeredTurn = await probe.startTurn(threadId, "Probe note: keep following the original steps.", {
            cwd: ws.b, runtimeWorkspaceRoots: [ws.b], sandboxPolicy: workspaceWrite(),
        });
        return switched();
    };
    const turn1 = await probe.startTurn(threadId, SEQUENTIAL(ws));
    const status1 = await probe.turnCompleted(turn1);
    const turn2 = await probe.startTurn(threadId, NEXT_TURN);
    const status2 = await probe.turnCompleted(turn2);
    return {
        name: "steer",
        probe,
        observations: [
            `active-turn turn/start returned turn=${short(steeredTurn)} (active turn=${short(turn1)}) — ${steeredTurn === turn1 ? "steered" : "started a new turn"}`,
            `turn1=${status1} turn2=${status2}`,
            ...commandLines(probe, threadId),
            `files ${sanitize(files(ws))}`,
            `final message: ${JSON.stringify(probe.finalMessages.get(threadId))}`,
        ],
    };
}

async function boundaryParallel(): Promise<Result>
{
    const probe = await Probe.open();
    const ws = makeWorkspace("boundary-parallel");
    const { threadId } = await probe.startThread(ws.a);
    const seen = deferred<ToolCall>();
    const held = deferred<ToolResponse>();
    probe.onSwitch = async (call) =>
    {
        seen.resolve(call);
        return held.promise;
    };
    const turn1 = await probe.startTurn(threadId, PARALLEL);
    const call = await Promise.race([seen.promise, probe.turnCompleted(turn1).then(() => null)]);
    if (!call)
    {
        return { name: "boundary-parallel", probe, observations: ["model never called the switch tool"] };
    }
    // Same delay as inplace-parallel, so a sibling call has been streamed and queued.
    await sleep(4_000);
    const beforeInterrupt = probe.commands.length;
    await probe.client.request("turn/interrupt", { threadId, turnId: call.turnId });
    const status1 = await probe.turnCompleted(turn1);
    const ranBeforeBoundary = probe.commands.length;
    // The held request was cancelled by the interrupt; a late answer shows what the server does with it.
    held.resolve(switched("late answer after interrupt"));
    await sleep(500);
    const turn2 = await probe.startTurn(threadId, "", {
        toolOutput: { name: SWITCH_TOOL, namespace: null, output: "Switched to workspace B. Continue with the remaining steps." },
        cwd: ws.b,
        runtimeWorkspaceRoots: [ws.b],
        sandboxPolicy: workspaceWrite(),
    });
    const status2 = await probe.turnCompleted(turn2);
    return {
        name: "boundary-parallel",
        probe,
        observations: [
            `turn1=${status1} (commands before interrupt=${beforeInterrupt}, after drain=${ranBeforeBoundary}) turn2=${status2}`,
            ...commandLines(probe, threadId),
            `files ${sanitize(files(ws))}`,
            `final message: ${JSON.stringify(probe.finalMessages.get(threadId))}`,
        ],
    };
}

async function concurrent(): Promise<Result>
{
    const probe = await Probe.open();
    const [one, two] = await Promise.all([
        inPlaceSequential("concurrent-1", probe),
        inPlaceSequential("concurrent-2", probe),
    ]);
    return { name: "concurrent", probe, observations: [...one.observations.map((o) => `[1] ${o}`), ...two.observations.map((o) => `[2] ${o}`)] };
}

function commandLines(probe: Probe, threadId: string): string[]
{
    return probe.commands
        .filter((c) => c.threadId === threadId)
        .map((c) => sanitize(`command turn=${short(c.turnId)} cwd=${c.cwd} exit=${c.exitCode} cmd=${JSON.stringify(c.command)} out=${JSON.stringify(c.output)}`));
}

// ── Through the adapter ─────────────────────────────────────────────────────

const APP_SERVER_ARGS = ["app-server", "-c", "notify=[]", "--listen", "stdio://"];

/**
 * Wraps the app-server transport to log every message, including requests a pooled worker sends
 * itself while a tool call is parked between steps, which no client's packet logger sees.
 */
class WireLog
{
    readonly log: string[] = [];
    readonly commands: CommandRecord[] = [];
    private readonly t0 = Date.now();
    private readonly methods = new Map<string | number, string>();

    note(line: string): void
    {
        this.log.push(`${String(Date.now() - this.t0).padStart(7)}ms  ${sanitize(line)}`);
    }

    wrap(inner: CodexTransport): CodexTransport
    {
        inner.on("message", (message) => this.inbound(message as Record<string, any>));
        const send = inner.sendMessage.bind(inner);
        inner.sendMessage = async (message) =>
        {
            this.outbound(message as Record<string, any>);
            await send(message);
        };
        return inner;
    }

    private outbound(m: Record<string, any>): void
    {
        if ("method" in m && "id" in m)
        {
            this.methods.set(m.id, m.method);
            if (["turn/settings/update", "thread/settings/update", "turn/start", "thread/start", "thread/resume"].includes(m.method))
            {
                this.note(`→ ${m.method} ${summarizeParams(m.params ?? {})}`);
            }
        }
        else if ("id" in m && "result" in m)
        {
            this.note(`→ tool response ${JSON.stringify(trim(JSON.stringify(m.result)))}`);
        }
    }

    private inbound(m: Record<string, any>): void
    {
        if ("id" in m && !("method" in m))
        {
            const method = this.methods.get(m.id);
            if (method?.includes("settings/update"))
            {
                this.note(`← ${method}: ${"error" in m ? `ERROR ${JSON.stringify(m.error)}` : JSON.stringify(m.result)}`);
            }
            return;
        }
        const p = m.params ?? {};
        if (m.method === "item/tool/call")
        {
            this.note(`⇐ item/tool/call ${p.tool} turn=${short(p.turnId)}`);
        }
        else if (m.method === "turn/completed")
        {
            this.note(`· turn/completed turn=${short(p.turn?.id)} status=${p.turn?.status}`);
        }
        else if (m.method === "item/completed" && p.item?.type === "commandExecution")
        {
            const item = p.item;
            this.note(`· command turn=${short(p.turnId)} cwd=${item.cwd} exit=${item.exitCode} cmd=${JSON.stringify(item.command)}`);
            this.commands.push({ threadId: p.threadId, turnId: p.turnId, command: item.command, cwd: item.cwd, exitCode: item.exitCode, output: trim(item.aggregatedOutput) });
        }
        else if (m.method === "item/completed" && p.item?.type === "agentMessage")
        {
            this.note(`· agentMessage ${JSON.stringify(trim(p.item.text))}`);
        }
    }
}

const SWITCH_DESCRIPTION = "Moves this session's execution context (working directory and writable workspace) to workspace B. Shell commands issued after this tool returns run in workspace B.";
const SWITCH_SCHEMA = { type: "object", properties: { target: { type: "string", enum: ["B"] } }, required: ["target"], additionalProperties: false } as const;

async function moveToB(wire: WireLog, session: CodexSession | undefined, ws: Workspace, turnId?: string): Promise<string>
{
    if (!session)
    {
        wire.note("switch: no session");
        return "Switch failed: no session.";
    }
    const result = await session.moveExecutionContext(stripUndefined({
        cwd: ws.b,
        runtimeWorkspaceRoots: [ws.b],
        sandboxPolicy: workspaceWrite() as any,
        expectedTurnId: turnId,
    }));
    wire.note(`moveExecutionContext → ${JSON.stringify(result)}`);
    return result.status === "moved" ? "Switched to workspace B." : `Switch failed: ${result.message}`;
}

async function adapterScenario(name: string, mode: "crosscall" | "dynamic"): Promise<Result>
{
    const ws = makeWorkspace(name);
    const wire = new WireLog();
    const pool = new CodexWorkerPool({
        poolSize: 1,
        idleTimeoutMs: 60_000,
        transportFactory: () => wire.wrap(new StdioTransport({ command: CODEX, args: APP_SERVER_ARGS })),
    });
    let session: CodexSession | undefined;
    const codex = createCodexAppServer({
        transportFactory: (context) => new PersistentTransport(stripUndefined({ pool, signal: context.signal, threadId: context.threadId })),
        onSessionCreated: (created) =>
        {
            session = created;
        },
        experimentalApi: true,
        ...mode === "dynamic"
            ? { tools: {
                [SWITCH_TOOL]: {
                    description: SWITCH_DESCRIPTION,
                    inputSchema: SWITCH_SCHEMA,
                    execute: async (_args, context) => ({
                        success: true,
                        contentItems: [{ type: "inputText" as const, text: await moveToB(wire, context.session, ws, context.turnId) }],
                    }),
                },
            } }
            : {},
    });
    const model = codex(process.env.PROBE_MODEL ?? "");
    const sdkTools = mode === "crosscall"
        ? {
            [SWITCH_TOOL]: tool({
                description: SWITCH_DESCRIPTION,
                inputSchema: jsonSchema<{ target: "B" }>(SWITCH_SCHEMA as any),
                // Runs between two doStream steps: the turn's tool call is parked on the worker.
                execute: () => moveToB(wire, session, ws),
            }),
        }
        : undefined;

    // Turn 1 starts in A. Later calls pass no cwd: a call-option cwd would move the thread back.
    const first = await generateText(stripUndefined({
        model,
        prompt: SEQUENTIAL(ws),
        tools: sdkTools,
        stopWhen: stepCountIs(15),
        providerOptions: { [CODEX_PROVIDER_ID]: { cwd: ws.a, sandbox: "workspace-write", approvalPolicy: "never" } },
    }) as Parameters<typeof generateText>[0]);
    const rawThreadId = first.steps[0]?.providerMetadata?.[CODEX_PROVIDER_ID]?.["threadId"];
    const threadId = typeof rawThreadId === "string" ? rawThreadId : "?";
    const messages: ModelMessage[] = [...first.response.messages, { role: "user", content: NEXT_TURN }];
    const second = await generateText(stripUndefined({ model, messages, tools: sdkTools, stopWhen: stepCountIs(10) }) as Parameters<typeof generateText>[0]);

    return {
        name,
        probe: { log: wire.log, close: () => pool.shutdown() },
        observations: [
            `turn1 steps=${first.steps.length} turn2 steps=${second.steps.length} thread=${short(threadId)}`,
            ...wire.commands.map((c) => sanitize(`command turn=${short(c.turnId)} cwd=${c.cwd} exit=${c.exitCode} cmd=${JSON.stringify(c.command)} out=${JSON.stringify(c.output)}`)),
            `files ${sanitize(files(ws))}`,
            `final message turn1: ${JSON.stringify(trim(first.text))}`,
            `final message turn2: ${JSON.stringify(trim(second.text))}`,
        ],
    };
}

const SCENARIOS: Record<string, () => Promise<Result>> = {
    "inplace-sequential": () => inPlaceSequential(),
    "inplace-parallel": inPlaceParallel,
    "gated-parallel": gatedParallel,
    "steer": steer,
    "boundary-parallel": boundaryParallel,
    "concurrent": concurrent,
    "adapter-crosscall": () => adapterScenario("adapter-crosscall", "crosscall"),
    "adapter-dynamic": () => adapterScenario("adapter-dynamic", "dynamic"),
};

const selected = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(SCENARIOS);
console.log(`codex: ${execFileSync(CODEX, ["--version"]).toString().trim()}  workspaces: ${sanitize(ROOT)}`);

try
{
    for (const name of selected)
    {
        const run = SCENARIOS[name];
        if (!run)
        {
            throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(", ")}`);
        }
        console.log(`\n=== ${name}`);
        const result = await run();
        console.log(result.probe.log.join("\n"));
        console.log("--- observations");
        console.log(result.observations.map((o) => `  ${o}`).join("\n"));
        await result.probe.close();
    }
}
finally
{
    if (process.env.KEEP_WORKSPACES !== "1")
    {
        rmSync(ROOT, { recursive: true, force: true });
    }
}

process.exit(0);
