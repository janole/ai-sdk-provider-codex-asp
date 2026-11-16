import { isAbsolute } from "node:path";

import type { AppServerClient } from "./client/app-server-client";
import type { UserInput } from "./protocol/app-server-protocol/v2/UserInput";
import type {
    CodexThreadSettingsUpdateParams,
    CodexThreadSettingsUpdateResult,
    CodexTurnEnvironmentParams,
    CodexTurnInterruptParams,
    CodexTurnInterruptResult,
    CodexTurnSettingsUpdateParams,
    CodexTurnSettingsUpdateResult,
    CodexTurnStartParams,
    CodexTurnStartResult,
    SandboxPolicy,
} from "./protocol/types";
import { stripUndefined } from "./utils/object";

/** The environment Codex selects for a local app server. */
const DEFAULT_ENVIRONMENT_ID = "local";
const DEFAULT_CONTEXT_MOVE_TIMEOUT_MS = 30_000;

/**
 * The execution context to move a running session to: its working directory, the workspace roots
 * the sandbox may write to, and the sandbox settings for future turns. The adapter applies exactly
 * this; it never keeps a root from the previous context.
 */
export interface CodexExecutionContext
{
    /** Absolute path of the new working directory. */
    cwd: string;
    /**
     * Absolute runtime workspace roots. Under `workspace-write` they are the writable roots.
     * Omitted means `[cwd]`. Pass the complete set: roots from the previous context are not kept.
     */
    runtimeWorkspaceRoots?: string[];
    /** Sandbox policy for the thread's future turns. Cannot be combined with `permissions`. */
    sandboxPolicy?: SandboxPolicy;
    /** Named permissions profile id for the thread's future turns. Cannot be combined with `sandboxPolicy`. */
    permissions?: string;
    /** Codex environment to move. Defaults to `"local"`. */
    environmentId?: string;
}

export interface CodexExecutionContextMoveRequest extends CodexExecutionContext
{
    /**
     * The turn the caller means to move, e.g. the `turnId` a dynamic tool handler received. A
     * request for any other turn is rejected as `targetUnavailable` instead of moving a later turn.
     */
    expectedTurnId?: string;
    /** Abandons the request if it fires before the first update is sent. Once sent, a move runs to its outcome. */
    signal?: AbortSignal;
    /** Timeout per settings request. Defaults to 30 s. */
    timeoutMs?: number;
}

export type CodexExecutionContextMoveFailureReason =
    /** The session's turn has ended, never started, or is not the expected turn. Nothing changed. */
    | "targetUnavailable"
    /** The request is malformed (relative path, conflicting sandbox settings). Nothing was sent. */
    | "invalidRequest"
    /** The signal fired before anything was sent. Nothing changed. */
    | "aborted"
    /** Codex rejected or never answered `turn/settings/update`. Nothing changed. */
    | "turnUpdateFailed"
    /** The running turn moved, but `thread/settings/update` failed: future turns keep the old context. */
    | "threadUpdateFailed";

export type CodexExecutionContextMoveResult =
    | {
        status: "moved";
        threadId: string;
        turnId: string;
        /** The new context applies from the running turn's next model step and to every later turn. */
        effective: "nextStep";
        /** The context now in force, with defaults filled in. */
        context: CodexExecutionContext & { environmentId: string; runtimeWorkspaceRoots: string[] };
        /** True when the context was already in force from an earlier move of this turn; nothing was sent. */
        noop: boolean;
    }
    | {
        status: "failed";
        threadId: string;
        turnId: string | undefined;
        reason: CodexExecutionContextMoveFailureReason;
        message: string;
        /**
         * Whether the running turn's next step already uses the new context. Only true for
         * `threadUpdateFailed`: the session is then split between two contexts and the consumer
         * should move it again (to either context) before relying on it.
         */
        turnApplied: boolean;
    };

export interface CodexSession
{
    readonly threadId: string;
    readonly turnId: string | undefined;
    /** Whether a model step of this session is attached to a live stream. */
    isActive(): boolean;
    injectMessage(input: string | UserInput[]): Promise<void>;
    interrupt(): Promise<void>;
    /**
     * Moves the running turn and the thread's future turns to a new execution context and resolves
     * once Codex has acknowledged both. Call it from the tool handler that requests the move,
     * before returning its result: the tool response is held until the move settles, so Codex's
     * next step is the first to run in the new directory.
     *
     * Actions the model emitted in the same step as the move may still run in the old context;
     * Codex has no ordering barrier for them. Running terminals and background processes are not
     * moved. Never throws: every outcome is a result. Requires Codex >= 0.169 with the
     * `experimentalApi` capability (enabled whenever tools are configured).
     */
    moveExecutionContext(request: CodexExecutionContextMoveRequest): Promise<CodexExecutionContextMoveResult>;
}

type Requester = <TResult>(method: string, params: unknown, timeoutMs: number) => Promise<TResult>;

type MovedContext = Extract<CodexExecutionContextMoveResult, { status: "moved" }>["context"];

export class CodexSessionImpl implements CodexSession
{
    private readonly _threadId: string;
    private _turnId: string | undefined;
    private _active = true;
    private _turnOpen = true;
    private _parked = false;
    private readonly client: AppServerClient;
    private readonly interruptTimeoutMs: number;
    private requester: Requester;
    private moveQueue: Promise<unknown> = Promise.resolve();
    private pendingMoves = 0;
    private appliedContext: { turnId: string; context: MovedContext } | undefined;

    constructor(opts: {
        client: AppServerClient;
        threadId: string;
        turnId: string | undefined;
        interruptTimeoutMs: number;
    })
    {
        this.client = opts.client;
        this._threadId = opts.threadId;
        this._turnId = opts.turnId;
        this.interruptTimeoutMs = opts.interruptTimeoutMs;
        this.requester = clientRequester(opts.client);
    }

    get threadId(): string
    {
        return this._threadId;
    }

    get turnId(): string | undefined
    {
        return this._turnId;
    }

    /** @internal Called by the model when turn/started arrives with a turnId. */
    setTurnId(turnId: string): void
    {
        if (turnId !== this._turnId)
        {
            this.appliedContext = undefined;
        }
        this._turnId = turnId;
    }

    /**
     * @internal Called by the model when its step closes. Unless the step parked a tool call (see
     * {@link park}), the turn is over and no context move can target it any more.
     */
    markInactive(): void
    {
        this._active = false;
        if (!this._parked)
        {
            this._turnOpen = false;
        }
    }

    /**
     * @internal The step is closing at a parked cross-call tool call while the turn keeps running.
     * Context moves go through `requester`, which must outlive the step's client.
     */
    park(requester: Requester): void
    {
        this._parked = true;
        this.requester = requester;
    }

    /** @internal The next step of the parked turn attached with its own client. */
    attach(client: AppServerClient): void
    {
        this._parked = false;
        this._active = true;
        this.requester = clientRequester(client);
    }

    /** @internal Resolves once every move requested so far has settled. Never rejects. */
    async settleContextMoves(): Promise<void>
    {
        while (this.pendingMoves > 0)
        {
            await this.moveQueue.catch(() => undefined);
        }
    }

    isActive(): boolean
    {
        return this._active;
    }

    /**
     * Inject follow-up input into the current thread.
     *
     * Uses turn/start which the app-server routes through steer_input when a
     * turn is already active, or starts a new turn otherwise. This avoids the
     * strict timing requirements of turn/steer (which needs codex/event/task_started
     * before it accepts input). We may revisit turn/steer in the future.
     */
    async injectMessage(input: string | UserInput[]): Promise<void>
    {
        if (!this._active)
        {
            throw new Error("Session is no longer active.");
        }

        const userInput: UserInput[] = typeof input === "string"
            ? [{ type: "text", text: input, text_elements: [] }]
            : input;

        const turnStartParams: CodexTurnStartParams = {
            threadId: this._threadId,
            input: userInput,
        };

        const result = await this.client.request<CodexTurnStartResult & { turn?: { id?: string } }>("turn/start", turnStartParams);

        // Update turnId if the server started a new turn
        const newTurnId = result.turnId ?? result.turn?.id;
        if (newTurnId)
        {
            this._turnId = newTurnId;
        }
    }

    async interrupt(): Promise<void>
    {
        if (!this._active || !this._turnId)
        {
            return;
        }

        const interruptParams: CodexTurnInterruptParams = {
            threadId: this._threadId,
            turnId: this._turnId,
        };

        await this.client.request<CodexTurnInterruptResult>(
            "turn/interrupt",
            interruptParams,
            this.interruptTimeoutMs,
        );
    }

    moveExecutionContext(request: CodexExecutionContextMoveRequest): Promise<CodexExecutionContextMoveResult>
    {
        // Serialized so two moves never interleave their turn and thread updates, which could
        // leave the running turn in one directory and future turns in another.
        this.pendingMoves++;
        const result = this.moveQueue.then(() => this.runMove(request)).finally(() =>
        {
            this.pendingMoves--;
        });
        this.moveQueue = result.catch(() => undefined);
        return result;
    }

    private async runMove(request: CodexExecutionContextMoveRequest): Promise<CodexExecutionContextMoveResult>
    {
        const threadId = this._threadId;
        const turnId = this._turnId;
        const fail = (reason: CodexExecutionContextMoveFailureReason, message: string, turnApplied = false): CodexExecutionContextMoveResult =>
            ({ status: "failed", threadId, turnId, reason, message, turnApplied });

        const invalid = validateContext(request);
        if (invalid)
        {
            return fail("invalidRequest", invalid);
        }

        if (!this._turnOpen || !turnId)
        {
            return fail("targetUnavailable", "The session has no running turn.");
        }

        if (request.expectedTurnId !== undefined && request.expectedTurnId !== turnId)
        {
            return fail("targetUnavailable", `Turn ${request.expectedTurnId} is not the session's running turn.`);
        }

        if (request.signal?.aborted)
        {
            return fail("aborted", "The move was aborted before it was sent.");
        }

        const context: MovedContext = stripUndefined({
            cwd: request.cwd,
            runtimeWorkspaceRoots: request.runtimeWorkspaceRoots ?? [request.cwd],
            sandboxPolicy: request.sandboxPolicy,
            permissions: request.permissions,
            environmentId: request.environmentId ?? DEFAULT_ENVIRONMENT_ID,
        });

        if (this.appliedContext?.turnId === turnId && sameContext(this.appliedContext.context, context))
        {
            return { status: "moved", threadId, turnId, effective: "nextStep", context, noop: true };
        }

        const timeoutMs = request.timeoutMs ?? DEFAULT_CONTEXT_MOVE_TIMEOUT_MS;
        const environments: CodexTurnEnvironmentParams[] = [{
            environmentId: context.environmentId,
            cwd: context.cwd,
            runtimeWorkspaceRoots: context.runtimeWorkspaceRoots,
        }];

        // The running turn first: if it has already ended (`targetUnavailable`), the thread's
        // future turns must not move either, or the reported failure would hide a half move.
        const turnParams: CodexTurnSettingsUpdateParams = { threadId, turnId, environments };
        try
        {
            const turnResult = await this.requester<CodexTurnSettingsUpdateResult>("turn/settings/update", turnParams, timeoutMs);
            if (turnResult?.status !== "applied")
            {
                if (turnResult?.status === "targetUnavailable")
                {
                    this._turnOpen = false;
                    return fail("targetUnavailable", "Codex reports the turn is no longer running.");
                }
                return fail("turnUpdateFailed", `Unexpected turn/settings/update status: ${String(turnResult?.status)}.`);
            }
        }
        catch (error)
        {
            return fail("turnUpdateFailed", errorMessage(error));
        }

        // From here on the running turn has moved, so the outcome must be reported even if the
        // caller has aborted in the meantime.
        const threadParams: CodexThreadSettingsUpdateParams = stripUndefined({
            threadId,
            cwd: context.cwd,
            environments,
            sandboxPolicy: context.sandboxPolicy,
            permissions: context.permissions,
        });
        try
        {
            await this.requester<CodexThreadSettingsUpdateResult>("thread/settings/update", threadParams, timeoutMs);
        }
        catch (error)
        {
            this.appliedContext = undefined;
            return fail("threadUpdateFailed", errorMessage(error), true);
        }

        this.appliedContext = { turnId, context };
        return { status: "moved", threadId, turnId, effective: "nextStep", context, noop: false };
    }
}

function clientRequester(client: AppServerClient): Requester
{
    return <TResult>(method: string, params: unknown, timeoutMs: number) => client.request<TResult>(method, params, timeoutMs);
}

function validateContext(request: CodexExecutionContext): string | undefined
{
    if (typeof request.cwd !== "string" || !isAbsolute(request.cwd))
    {
        return "cwd must be an absolute path.";
    }

    if (request.runtimeWorkspaceRoots?.some((root) => typeof root !== "string" || !isAbsolute(root)))
    {
        return "runtimeWorkspaceRoots must be absolute paths.";
    }

    if (request.sandboxPolicy !== undefined && request.permissions !== undefined)
    {
        return "sandboxPolicy and permissions cannot be combined.";
    }

    return undefined;
}

function sameContext(a: MovedContext, b: MovedContext): boolean
{
    return a.cwd === b.cwd
        && a.environmentId === b.environmentId
        && a.permissions === b.permissions
        && JSON.stringify(a.runtimeWorkspaceRoots) === JSON.stringify(b.runtimeWorkspaceRoots)
        && JSON.stringify(a.sandboxPolicy) === JSON.stringify(b.sandboxPolicy);
}

function errorMessage(error: unknown): string
{
    return error instanceof Error ? error.message : String(error);
}
