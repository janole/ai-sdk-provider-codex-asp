/**
 * Probes Codex's per-thread writer lease against the real `codex` binary — no model call.
 *
 * Asserts the three facts the worker pool's thread affinity rests on:
 *   1. A thread loaded in app-server A cannot be `thread/resume`d in app-server B.
 *   2. `thread/unsubscribe` in A does not release it (so affinity, not unloading, is the fix).
 *   3. Through `CodexWorkerPool`, a resume reaches the owning worker even when another
 *      idle worker comes first.
 * Run it after a `codex` upgrade: a failed check 1 or 2 means the lease changed and the
 * affinity rules may be loosened; a failed check 3 is a pool regression.
 *
 * Run with:
 *   npx tsx scripts/writer-lease-probe.ts
 */

import { AppServerClient } from "../src/client/app-server-client";
import { PersistentTransport } from "../src/client/transport-persistent";
import { StdioTransport } from "../src/client/transport-stdio";
import { CodexWorkerPool } from "../src/client/worker-pool";

const CWD = process.cwd();

async function open(transport: StdioTransport | PersistentTransport): Promise<AppServerClient>
{
    const client = new AppServerClient(transport);
    await client.connect();
    await client.request("initialize", { clientInfo: { name: "writer-lease-probe", version: "0" }, capabilities: { experimentalApi: true } });
    await client.notification("initialized");
    return client;
}

/** Starts a thread and persists one item, so it has a rollout another process could resume. */
async function startPersistedThread(client: AppServerClient): Promise<string>
{
    const started = await client.request<{ thread: { id: string } }>("thread/start", { cwd: CWD });
    const threadId = started.thread.id;
    await client.request("thread/inject_items", {
        threadId,
        items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "writer-lease probe" }] }],
    });
    return threadId;
}

async function resumeError(client: AppServerClient, threadId: string): Promise<string | null>
{
    try
    {
        await client.request("thread/resume", { threadId, cwd: CWD });
        return null;
    }
    catch (error)
    {
        return error instanceof Error ? error.message : String(error);
    }
}

let failed = false;

function check(label: string, ok: boolean, detail: string): void
{
    console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
    failed ||= !ok;
}

const a = await open(new StdioTransport());
const b = await open(new StdioTransport());

try
{
    const threadId = await startPersistedThread(a);

    const whileLoaded = await resumeError(b, threadId);
    check("lease blocks a second process", whileLoaded?.includes("active writer") === true, whileLoaded ?? "resume succeeded");

    await a.request("thread/unsubscribe", { threadId });
    const afterUnsubscribe = await resumeError(b, threadId);
    check("unsubscribe keeps the lease", afterUnsubscribe?.includes("active writer") === true, afterUnsubscribe ?? "resume succeeded");
}
finally
{
    await a.disconnect();
    await b.disconnect();
}

const pool = new CodexWorkerPool({ poolSize: 2, transportFactory: () => new StdioTransport(), idleTimeoutMs: 0 });

try
{
    // Hold the first slot so the thread starts on the second, then free both.
    const first = new PersistentTransport({ pool });
    const firstClient = await open(first);
    const second = new PersistentTransport({ pool });
    const threadId = await startPersistedThread(await open(second));
    await second.disconnect();
    await firstClient.disconnect();

    const resumed = new PersistentTransport({ pool, threadId });
    const error = await resumeError(await open(resumed), threadId);
    check("pool resumes on the owning worker", error === null, error ?? "resume succeeded");
    await resumed.disconnect();
}
finally
{
    await pool.shutdown();
}

process.exit(failed ? 1 : 0);
