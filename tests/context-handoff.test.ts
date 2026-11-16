import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import type { AppServerClient } from "../src/client/app-server-client";
import type { JsonRpcMessage } from "../src/client/transport";
import { PersistentTransport } from "../src/client/transport-persistent";
import { CodexWorkerPool } from "../src/client/worker-pool";
import { CODEX_PROVIDER_ID } from "../src/protocol/provider-metadata";
import { createCodexAppServer } from "../src/provider";
import type { CodexSession } from "../src/session";
import { CodexSessionImpl } from "../src/session";
import { stripUndefined } from "../src/utils/object";
import { MockTransport } from "./helpers/mock-transport";

// ── Session-level fakes ──────────────────────────────────────────────────────

type SettingsReply =
    | { result: unknown }
    | { error: { code: number; message: string } }
    | { hold: Promise<{ result: unknown } | { error: { code: number; message: string } }> };

const APPLIED: SettingsReply = { result: { status: "applied" } };
const THREAD_OK: SettingsReply = { result: {} };

/** Records requests and answers settings updates from a per-method script. */
class FakeClient
{
    readonly calls: Array<{ method: string; params: unknown }> = [];
    readonly log: string[] = [];
    replies: Record<string, SettingsReply[]> = {};

    async request<T>(method: string, params: unknown): Promise<T>
    {
        this.calls.push({ method, params });
        this.log.push(`send ${method}`);
        const reply = this.replies[method]?.shift() ?? (method === "turn/settings/update" ? APPLIED : THREAD_OK);
        const settled = "hold" in reply ? await reply.hold : reply;
        this.log.push(`ack ${method}`);
        if ("error" in settled)
        {
            throw new Error(settled.error.message);
        }
        return settled.result as T;
    }
}

function createSession(client = new FakeClient(), turnId: string | null = "turn_1")
{
    const session = new CodexSessionImpl({
        client: client as unknown as AppServerClient,
        threadId: "thr_1",
        turnId: turnId ?? undefined,
        interruptTimeoutMs: 1000,
    });
    return { session, client };
}

function deferred<T>()
{
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) =>
    {
        resolve = r;
    });
    return { promise, resolve };
}

describe("CodexSession.moveExecutionContext", () =>
{
    it("updates the running turn, then the thread, and reports the move effective from the next step", async () =>
    {
        const { session, client } = createSession();

        const result = await session.moveExecutionContext({
            cwd: "/work/b",
            runtimeWorkspaceRoots: ["/work/b", "/shared"],
            sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        });

        expect(client.calls).toEqual([
            {
                method: "turn/settings/update",
                params: {
                    threadId: "thr_1",
                    turnId: "turn_1",
                    environments: [{ environmentId: "local", cwd: "/work/b", runtimeWorkspaceRoots: ["/work/b", "/shared"] }],
                },
            },
            {
                method: "thread/settings/update",
                params: {
                    threadId: "thr_1",
                    cwd: "/work/b",
                    environments: [{ environmentId: "local", cwd: "/work/b", runtimeWorkspaceRoots: ["/work/b", "/shared"] }],
                    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                },
            },
        ]);
        expect(result).toMatchObject({
            status: "moved",
            threadId: "thr_1",
            turnId: "turn_1",
            effective: "nextStep",
            noop: false,
            context: { cwd: "/work/b", environmentId: "local", runtimeWorkspaceRoots: ["/work/b", "/shared"] },
        });
    });

    it("defaults the workspace roots to the new cwd and never carries the old ones", async () =>
    {
        const { session, client } = createSession();

        await session.moveExecutionContext({ cwd: "/work/b", runtimeWorkspaceRoots: ["/work/b", "/work/a"] });
        await session.moveExecutionContext({ cwd: "/work/c" });

        const lastTurnUpdate = client.calls[2]?.params as { environments: Array<{ runtimeWorkspaceRoots: string[] }> };
        expect(lastTurnUpdate.environments[0]?.runtimeWorkspaceRoots).toEqual(["/work/c"]);
        const lastThreadUpdate = client.calls[3]?.params as Record<string, unknown>;
        expect(lastThreadUpdate).not.toHaveProperty("sandboxPolicy");
        expect(lastThreadUpdate).not.toHaveProperty("permissions");
    });

    it("passes a permissions profile instead of a sandbox policy", async () =>
    {
        const { session, client } = createSession();

        await session.moveExecutionContext({ cwd: "/work/b", permissions: "workspace" });

        expect(client.calls[1]?.params).toMatchObject({ permissions: "workspace" });
        expect(client.calls[1]?.params).not.toHaveProperty("sandboxPolicy");
    });

    it("treats a move to the context already in force for this turn as a no-op", async () =>
    {
        const { session, client } = createSession();

        await session.moveExecutionContext({ cwd: "/work/b" });
        const again = await session.moveExecutionContext({ cwd: "/work/b", runtimeWorkspaceRoots: ["/work/b"] });

        expect(again).toMatchObject({ status: "moved", noop: true });
        expect(client.calls).toHaveLength(2);
    });

    it("sends a repeated move again once the turn has changed", async () =>
    {
        const { session, client } = createSession();

        await session.moveExecutionContext({ cwd: "/work/b" });
        session.setTurnId("turn_2");
        const again = await session.moveExecutionContext({ cwd: "/work/b" });

        expect(again).toMatchObject({ status: "moved", turnId: "turn_2", noop: false });
        expect(client.calls).toHaveLength(4);
    });

    it("applies repeated moves in order, each one acknowledged", async () =>
    {
        const { session, client } = createSession();

        const results = [
            await session.moveExecutionContext({ cwd: "/work/b" }),
            await session.moveExecutionContext({ cwd: "/work/c" }),
            await session.moveExecutionContext({ cwd: "/work/b" }),
        ];

        expect(results.map((r) => r.status)).toEqual(["moved", "moved", "moved"]);
        expect(results.map((r) => r.status === "moved" && r.noop)).toEqual([false, false, false]);
        expect(client.calls.map((c) => (c.params as { cwd?: string; environments: Array<{ cwd: string }> }).environments[0]?.cwd))
            .toEqual(["/work/b", "/work/b", "/work/c", "/work/c", "/work/b", "/work/b"]);
    });

    it("serializes parallel moves so their turn and thread updates never interleave", async () =>
    {
        const client = new FakeClient();
        const firstTurnAck = deferred<{ result: unknown }>();
        client.replies["turn/settings/update"] = [{ hold: firstTurnAck.promise }, APPLIED];
        const { session } = createSession(client);

        const first = session.moveExecutionContext({ cwd: "/work/b" });
        const second = session.moveExecutionContext({ cwd: "/work/c" });
        await Promise.resolve();
        await Promise.resolve();
        firstTurnAck.resolve({ result: { status: "applied" } });

        expect((await first).status).toBe("moved");
        expect((await second).status).toBe("moved");
        expect(client.log).toEqual([
            "send turn/settings/update", "ack turn/settings/update",
            "send thread/settings/update", "ack thread/settings/update",
            "send turn/settings/update", "ack turn/settings/update",
            "send thread/settings/update", "ack thread/settings/update",
        ]);
        expect((client.calls[2]?.params as { environments: Array<{ cwd: string }> }).environments[0]?.cwd).toBe("/work/c");
    });

    it("settleContextMoves waits for every move in flight", async () =>
    {
        const client = new FakeClient();
        const threadAck = deferred<{ result: unknown }>();
        client.replies["thread/settings/update"] = [{ hold: threadAck.promise }];
        const { session } = createSession(client);

        void session.moveExecutionContext({ cwd: "/work/b" });
        let settled = false;
        const settling = session.settleContextMoves().then(() =>
        {
            settled = true;
        });
        await new Promise((r) => setTimeout(r, 5));
        expect(settled).toBe(false);

        threadAck.resolve({ result: {} });
        await settling;
        expect(settled).toBe(true);
    });

    it("reports a turn Codex no longer runs as targetUnavailable and leaves future turns alone", async () =>
    {
        const client = new FakeClient();
        client.replies["turn/settings/update"] = [{ result: { status: "targetUnavailable" } }];
        const { session } = createSession(client);

        const result = await session.moveExecutionContext({ cwd: "/work/b" });
        const later = await session.moveExecutionContext({ cwd: "/work/b" });

        expect(result).toMatchObject({ status: "failed", reason: "targetUnavailable", turnApplied: false });
        expect(later).toMatchObject({ status: "failed", reason: "targetUnavailable" });
        expect(client.calls.map((c) => c.method)).toEqual(["turn/settings/update"]);
    });

    it("rejects a move on an ended session without sending anything", async () =>
    {
        const { session, client } = createSession();
        session.markInactive();

        const result = await session.moveExecutionContext({ cwd: "/work/b" });

        expect(result).toMatchObject({ status: "failed", reason: "targetUnavailable" });
        expect(client.calls).toHaveLength(0);
    });

    it("rejects a move for a session whose turn has not started", async () =>
    {
        const { session, client } = createSession(new FakeClient(), null);

        expect(await session.moveExecutionContext({ cwd: "/work/b" })).toMatchObject({ status: "failed", reason: "targetUnavailable" });
        expect(client.calls).toHaveLength(0);
    });

    it("rejects a stale request aimed at another turn", async () =>
    {
        const { session, client } = createSession();

        const result = await session.moveExecutionContext({ cwd: "/work/b", expectedTurnId: "turn_0" });

        expect(result).toMatchObject({ status: "failed", reason: "targetUnavailable", turnId: "turn_1" });
        expect(client.calls).toHaveLength(0);
    });

    it.each([
        [{ cwd: "relative/b" }, "cwd must be an absolute path."],
        [{ cwd: "/work/b", runtimeWorkspaceRoots: ["/work/b", "shared"] }, "runtimeWorkspaceRoots must be absolute paths."],
        [{ cwd: "/work/b", permissions: "p", sandboxPolicy: { type: "dangerFullAccess" as const } }, "sandboxPolicy and permissions cannot be combined."],
        [{ cwd: "/work/b", runtimeWorkspaceRoots: "/work/b" as unknown as string[] }, "runtimeWorkspaceRoots must be absolute paths."],
    ])("rejects an invalid request without sending anything (%#)", async (request, message) =>
    {
        const { session, client } = createSession();

        expect(await session.moveExecutionContext(request)).toMatchObject({ status: "failed", reason: "invalidRequest", message });
        expect(client.calls).toHaveLength(0);
    });

    it("reports a rejected turn update as failed without touching the thread", async () =>
    {
        const client = new FakeClient();
        client.replies["turn/settings/update"] = [{ error: { code: -32600, message: "turn/settings/update requires experimentalApi capability" } }];
        const { session } = createSession(client);

        const result = await session.moveExecutionContext({ cwd: "/work/b" });

        expect(result).toMatchObject({ status: "failed", reason: "turnUpdateFailed", turnApplied: false });
        expect(result.status === "failed" && result.message).toContain("experimentalApi");
        expect(client.calls.map((c) => c.method)).toEqual(["turn/settings/update"]);
    });

    it("reports a partial move as failed, never as moved, and does not treat the retry as a no-op", async () =>
    {
        const client = new FakeClient();
        client.replies["thread/settings/update"] = [{ error: { code: -32000, message: "rejected by core" } }];
        const { session } = createSession(client);

        const result = await session.moveExecutionContext({ cwd: "/work/b" });
        const retry = await session.moveExecutionContext({ cwd: "/work/b" });

        expect(result).toMatchObject({ status: "failed", reason: "threadUpdateFailed", turnApplied: true, message: "rejected by core" });
        expect(retry).toMatchObject({ status: "moved", noop: false });
        expect(client.calls).toHaveLength(4);
    });

    it("abandons an aborted request before anything is sent", async () =>
    {
        const { session, client } = createSession();
        const controller = new AbortController();
        controller.abort();

        expect(await session.moveExecutionContext({ cwd: "/work/b", signal: controller.signal })).toMatchObject({ status: "failed", reason: "aborted" });
        expect(client.calls).toHaveLength(0);
    });

    it("finishes a move that was already sent when the caller aborts", async () =>
    {
        const client = new FakeClient();
        const turnAck = deferred<{ result: unknown }>();
        client.replies["turn/settings/update"] = [{ hold: turnAck.promise }];
        const { session } = createSession(client);
        const controller = new AbortController();

        const pending = session.moveExecutionContext({ cwd: "/work/b", signal: controller.signal });
        await Promise.resolve();
        controller.abort();
        turnAck.resolve({ result: { status: "applied" } });

        expect(await pending).toMatchObject({ status: "moved" });
        expect(client.calls.map((c) => c.method)).toEqual(["turn/settings/update", "thread/settings/update"]);
    });

    it("keeps a parked session's turn open and routes its moves through the parked channel", async () =>
    {
        const { session, client } = createSession();
        const parkedCalls: string[] = [];
        session.park(<T>(method: string) =>
        {
            parkedCalls.push(method);
            return Promise.resolve((method === "turn/settings/update" ? { status: "applied" } : {}) as T);
        });
        session.markInactive();

        expect(session.isActive()).toBe(false);
        expect(await session.moveExecutionContext({ cwd: "/work/b" })).toMatchObject({ status: "moved" });
        expect(parkedCalls).toEqual(["turn/settings/update", "thread/settings/update"]);
        expect(client.calls).toHaveLength(0);
    });
});

// ── Model integration over a scripted app server ────────────────────────────

interface ScriptedCall
{
    callId: string;
    tool: string;
    args: Record<string, unknown>;
}

/**
 * Scripts Codex: each turn emits its tool calls one by one and completes after the last response.
 * Settings updates are answered by `settingsReply`, which may hold the answer back.
 */
class HandoffTransport extends MockTransport
{
    readonly wire: string[] = [];
    settingsReply: (method: string, params: unknown) => SettingsReply = (method) => method === "turn/settings/update" ? APPLIED : THREAD_OK;
    private threadCount = 0;
    private turnCount = 0;
    private calls: ScriptedCall[] = [];
    private callIndex = 0;
    private nextRequestId = 500;
    private currentRequestId = -1;
    private threadId = "";
    private turnId = "";

    constructor(private readonly script: ScriptedCall[][])
    {
        super();
    }

    override async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        await super.sendMessage(message);

        if (!("method" in message))
        {
            if ("id" in message && message.id === this.currentRequestId && "result" in message)
            {
                this.wire.push(`tool-response ${this.calls[this.callIndex]?.callId}`);
                this.callIndex++;
                queueMicrotask(() => this.emitNextOrComplete());
            }
            return;
        }

        if (!("id" in message) || message.id === undefined)
        {
            return;
        }

        const { id, method } = message;
        const params = (message as { params?: unknown }).params;

        switch (method)
        {
            case "initialize":
                this.emitMessage({ id, result: { userAgent: "codex/0.169.0" } });
                return;
            case "thread/start":
                this.threadId = `thr_${++this.threadCount}`;
                this.wire.push(`thread/start ${JSON.stringify(params)}`);
                this.emitMessage({ id, result: { thread: { id: this.threadId } } });
                return;
            case "thread/resume":
                this.emitMessage({ id, result: { thread: { id: this.threadId } } });
                return;
            case "turn/start":
                this.turnId = `turn_${++this.turnCount}`;
                this.calls = this.script.shift() ?? [];
                this.callIndex = 0;
                this.emitMessage({ id, result: { turn: { id: this.turnId } } });
                // A real model takes far longer than the turn/start round trip.
                setTimeout(() =>
                {
                    this.emitMessage({ method: "turn/started", params: { threadId: this.threadId, turn: { id: this.turnId } } });
                    this.emitNextOrComplete();
                }, 0);
                return;
            case "turn/settings/update":
            case "thread/settings/update":
            {
                this.wire.push(`send ${method}`);
                const reply = this.settingsReply(method, params);
                const answer = (settled: { result: unknown } | { error: { code: number; message: string } }) =>
                {
                    this.wire.push(`ack ${method}`);
                    this.emitMessage({ id, ...settled });
                };
                if ("hold" in reply)
                {
                    void reply.hold.then(answer);
                }
                else
                {
                    answer(reply);
                }
                return;
            }
            default:
                return;
        }
    }

    private emitNextOrComplete(): void
    {
        const call = this.calls[this.callIndex];
        if (!call)
        {
            this.emitMessage({
                method: "turn/completed",
                params: { threadId: this.threadId, turn: { id: this.turnId, items: [], status: "completed", error: null } },
            });
            return;
        }

        this.currentRequestId = this.nextRequestId++;
        this.wire.push(`tool-call ${call.callId}`);
        this.emitMessage({
            id: this.currentRequestId,
            method: "item/tool/call",
            params: { threadId: this.threadId, turnId: this.turnId, callId: call.callId, tool: call.tool, arguments: call.args },
        });
    }
}

const SWITCH_TOOL: LanguageModelV3FunctionTool = {
    type: "function",
    name: "switch_workspace",
    description: "Switch to another workspace.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const SWITCH_CALL: ScriptedCall = { callId: "call_switch", tool: "switch_workspace", args: { path: "/work/b" } };

async function readAll(stream: ReadableStream<unknown>): Promise<Array<{ type: string;[key: string]: unknown }>>
{
    const reader = stream.getReader();
    const parts: Array<{ type: string;[key: string]: unknown }> = [];
    while (true)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        parts.push(value as { type: string });
    }
    return parts;
}

function createPersistentProvider(transport: MockTransport, sessions: CodexSession[])
{
    const pool = new CodexWorkerPool({ poolSize: 1, transportFactory: () => transport, idleTimeoutMs: 60_000 });
    const provider = createCodexAppServer({
        transportFactory: (context) => new PersistentTransport(stripUndefined({ pool, signal: context.signal, threadId: context.threadId })),
        clientInfo: { name: "test", version: "1.0.0" },
        onSessionCreated: (session) => sessions.push(session),
    });
    return { pool, model: provider.languageModel("codex-test") };
}

function toolResultPrompt(threadId: string)
{
    return [
        { role: "user" as const, content: [{ type: "text" as const, text: "Move to B" }] },
        {
            role: "assistant" as const,
            content: [{ type: "tool-call" as const, toolCallId: "call_switch", toolName: "switch_workspace", input: { path: "/work/b" } }],
            providerOptions: { [CODEX_PROVIDER_ID]: { threadId } },
        },
        {
            role: "tool" as const,
            content: [{ type: "tool-result" as const, toolCallId: "call_switch", toolName: "switch_workspace", output: { type: "text" as const, value: "moved" } }],
        },
    ];
}

describe("context handoff through the language model", () =>
{
    it("moves a parked cross-call turn between steps, acknowledged before the tool response", async () =>
    {
        const transport = new HandoffTransport([[SWITCH_CALL]]);
        const sessions: CodexSession[] = [];
        const { pool, model } = createPersistentProvider(transport, sessions);

        try
        {
            const first = await readAll((await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Move to B" }] }],
                tools: [SWITCH_TOOL],
            })).stream);
            expect(first.find((p) => p.type === "finish")?.finishReason).toMatchObject({ unified: "tool-calls" });

            // The AI SDK runs the tool now, between steps: no client is attached to the worker.
            const session = sessions[0]!;
            expect(session.isActive()).toBe(false);
            const moved = await session.moveExecutionContext({ cwd: "/work/b", expectedTurnId: "turn_1" });
            expect(moved).toMatchObject({ status: "moved", threadId: "thr_1", turnId: "turn_1", effective: "nextStep" });

            const second = await readAll((await model.doStream({ prompt: toolResultPrompt("thr_1"), tools: [SWITCH_TOOL] })).stream);
            expect(second.find((p) => p.type === "finish")?.finishReason).toMatchObject({ unified: "stop" });

            expect(transport.wire.filter((w) => !w.startsWith("thread/start"))).toEqual([
                "tool-call call_switch",
                "send turn/settings/update", "ack turn/settings/update",
                "send thread/settings/update", "ack thread/settings/update",
                "tool-response call_switch",
            ]);

            // The turn is over: the same handle can no longer move anything.
            expect(await session.moveExecutionContext({ cwd: "/work/c" })).toMatchObject({ status: "failed", reason: "targetUnavailable" });
            expect(transport.wire.filter((w) => w.startsWith("send"))).toHaveLength(2);
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("holds the cross-call tool response until a move the tool did not await is acknowledged", async () =>
    {
        const transport = new HandoffTransport([[SWITCH_CALL]]);
        const threadAck = deferred<{ result: unknown }>();
        transport.settingsReply = (method) => method === "thread/settings/update" ? { hold: threadAck.promise } : APPLIED;
        const sessions: CodexSession[] = [];
        const { pool, model } = createPersistentProvider(transport, sessions);

        try
        {
            await readAll((await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Move to B" }] }],
                tools: [SWITCH_TOOL],
            })).stream);

            const moving = sessions[0]!.moveExecutionContext({ cwd: "/work/b" });
            const second = model.doStream({ prompt: toolResultPrompt("thr_1"), tools: [SWITCH_TOOL] }).then((r) => readAll(r.stream));

            await new Promise((r) => setTimeout(r, 10));
            expect(transport.wire).not.toContain("tool-response call_switch");

            threadAck.resolve({ result: {} });
            expect(await moving).toMatchObject({ status: "moved" });
            await second;

            const wire = transport.wire;
            expect(wire.indexOf("ack thread/settings/update")).toBeLessThan(wire.indexOf("tool-response call_switch"));
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("keeps the session across chained cross-call steps of one turn", async () =>
    {
        const lookup: ScriptedCall = { callId: "call_lookup", tool: "switch_workspace", args: { path: "/work/a" } };
        const transport = new HandoffTransport([[lookup, SWITCH_CALL]]);
        const sessions: CodexSession[] = [];
        const { pool, model } = createPersistentProvider(transport, sessions);

        try
        {
            await readAll((await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Move to B" }] }],
                tools: [SWITCH_TOOL],
            })).stream);

            // Second step answers the first call and parks the second.
            const prompt = [
                { role: "user" as const, content: [{ type: "text" as const, text: "Move to B" }] },
                {
                    role: "assistant" as const,
                    content: [{ type: "tool-call" as const, toolCallId: "call_lookup", toolName: "switch_workspace", input: {} }],
                    providerOptions: { [CODEX_PROVIDER_ID]: { threadId: "thr_1" } },
                },
                {
                    role: "tool" as const,
                    content: [{ type: "tool-result" as const, toolCallId: "call_lookup", toolName: "switch_workspace", output: { type: "text" as const, value: "ok" } }],
                },
            ];
            const secondStep = await readAll((await model.doStream({ prompt, tools: [SWITCH_TOOL] })).stream);
            expect(secondStep.find((p) => p.type === "finish")?.finishReason).toMatchObject({ unified: "tool-calls" });

            expect(sessions).toHaveLength(1);
            expect(await sessions[0]!.moveExecutionContext({ cwd: "/work/b" })).toMatchObject({ status: "moved", turnId: "turn_1" });

            await readAll((await model.doStream({ prompt: toolResultPrompt("thr_1"), tools: [SWITCH_TOOL] })).stream);
            const wire = transport.wire;
            expect(wire.indexOf("ack thread/settings/update")).toBeLessThan(wire.indexOf("tool-response call_switch"));
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("does not let a reused worker carry a finished session's context into another session", async () =>
    {
        const transport = new HandoffTransport([[SWITCH_CALL], []]);
        const sessions: CodexSession[] = [];
        const { pool, model } = createPersistentProvider(transport, sessions);

        try
        {
            await readAll((await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Move to B" }] }],
                tools: [SWITCH_TOOL],
                providerOptions: { [CODEX_PROVIDER_ID]: { cwd: "/work/a" } },
            })).stream);
            await sessions[0]!.moveExecutionContext({ cwd: "/work/b" });
            await readAll((await model.doStream({ prompt: toolResultPrompt("thr_1"), tools: [SWITCH_TOOL] })).stream);

            // A fresh conversation on the same (only) worker.
            await readAll((await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
                providerOptions: { [CODEX_PROVIDER_ID]: { cwd: "/work/other" } },
            })).stream);

            expect(sessions).toHaveLength(2);
            expect(sessions[1]).not.toBe(sessions[0]);
            expect(sessions[1]!.threadId).toBe("thr_2");
            const threadStarts = transport.wire.filter((w) => w.startsWith("thread/start"));
            expect(threadStarts[1]).toContain("\"cwd\":\"/work/other\"");
            expect(threadStarts[1]).not.toContain("/work/b");

            // The first session stays ended even though its worker is busy with another one.
            expect(await sessions[0]!.moveExecutionContext({ cwd: "/work/c" })).toMatchObject({ status: "failed", reason: "targetUnavailable" });
            expect(transport.wire.filter((w) => w.startsWith("send"))).toHaveLength(2);
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("fails a parked move whose worker died instead of reporting it moved", async () =>
    {
        const transport = new HandoffTransport([[SWITCH_CALL]]);
        transport.settingsReply = () => ({ hold: new Promise(() => undefined) });
        const sessions: CodexSession[] = [];
        const { pool, model } = createPersistentProvider(transport, sessions);

        try
        {
            await readAll((await model.doStream({
                prompt: [{ role: "user", content: [{ type: "text", text: "Move to B" }] }],
                tools: [SWITCH_TOOL],
            })).stream);

            const moving = sessions[0]!.moveExecutionContext({ cwd: "/work/b" });
            await new Promise((r) => setTimeout(r, 5));
            transport.emitClose(1, null);

            expect(await moving).toMatchObject({ status: "failed", reason: "turnUpdateFailed", turnApplied: false });
        }
        finally
        {
            await pool.shutdown();
        }
    });

    it("lets a provider-executed dynamic tool move the session before its response goes out", async () =>
    {
        const transport = new HandoffTransport([[SWITCH_CALL]]);
        const threadAck = deferred<{ result: unknown }>();
        transport.settingsReply = (method) => method === "thread/settings/update" ? { hold: threadAck.promise } : APPLIED;
        let moveResult: Promise<unknown> | undefined;

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test", version: "1.0.0" },
            experimentalApi: true,
            tools: {
                switch_workspace: {
                    description: "Switch to another workspace.",
                    inputSchema: { type: "object" },
                    execute: (_args, context) =>
                    {
                        // Deliberately not awaited: the adapter still holds the response.
                        moveResult = context.session?.moveExecutionContext(stripUndefined({ cwd: "/work/b", expectedTurnId: context.turnId }));
                        setTimeout(() => threadAck.resolve({ result: {} }), 10);
                        return Promise.resolve({ success: true, contentItems: [{ type: "inputText", text: "moved" }] });
                    },
                },
            },
        });

        const parts = await readAll((await provider.languageModel("codex-test").doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "Move to B" }] }],
        })).stream);

        expect(parts.find((p) => p.type === "finish")?.finishReason).toMatchObject({ unified: "stop" });
        expect(await moveResult).toMatchObject({ status: "moved", turnId: "turn_1" });
        expect(transport.wire).toEqual([
            expect.stringMatching(/^thread\/start/),
            "tool-call call_switch",
            "send turn/settings/update", "ack turn/settings/update",
            "send thread/settings/update", "ack thread/settings/update",
            "tool-response call_switch",
        ]);
    });
});
