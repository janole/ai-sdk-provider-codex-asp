import type { AppServerClient } from "./client/app-server-client";
import type { TurnSteerParams } from "./protocol/app-server-protocol/v2/TurnSteerParams";
import type { TurnSteerResponse } from "./protocol/app-server-protocol/v2/TurnSteerResponse";
import type { UserInput } from "./protocol/app-server-protocol/v2/UserInput";
import type { CodexTurnInterruptParams, CodexTurnInterruptResult } from "./protocol/types";

export interface CodexSession
{
    readonly threadId: string;
    readonly turnId: string | undefined;
    isActive(): boolean;
    injectMessage(input: string | UserInput[]): Promise<void>;
    interrupt(): Promise<void>;
}

export class CodexSessionImpl implements CodexSession
{
    private readonly _threadId: string;
    private _turnId: string | undefined;
    private _active = true;
    private readonly client: AppServerClient;
    private readonly interruptTimeoutMs: number;

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
        this._turnId = turnId;
    }

    /** @internal Called by the model when the turn completes or the stream closes. */
    markInactive(): void
    {
        this._active = false;
    }

    isActive(): boolean
    {
        return this._active;
    }

    async injectMessage(input: string | UserInput[]): Promise<void>
    {
        if (!this._active)
        {
            throw new Error("Session is no longer active.");
        }

        if (!this._turnId)
        {
            throw new Error("No active turn to steer.");
        }

        const userInput: UserInput[] = typeof input === "string"
            ? [{ type: "text", text: input, text_elements: [] }]
            : input;

        const steerParams: TurnSteerParams = {
            threadId: this._threadId,
            input: userInput,
            expectedTurnId: this._turnId,
        };

        await this.client.request<TurnSteerResponse>("turn/steer", steerParams);
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
}
