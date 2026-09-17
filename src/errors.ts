import type { CodexErrorInfo } from "./protocol/app-server-protocol/v2/CodexErrorInfo";
import type { TurnError } from "./protocol/app-server-protocol/v2/TurnError";

/** Base error type for this provider package. */
export class CodexProviderError extends Error 
{
    constructor(message: string, options?: { cause?: unknown }) 
    {
        super(message, options);
        this.name = "CodexProviderError";
    }
}

/** Error used for methods intentionally left as stubs in early PRs. */
export class CodexNotImplementedError extends CodexProviderError 
{
    constructor(method: string) 
    {
        super(`Codex provider method not implemented yet: ${method}`);
        this.name = "CodexNotImplementedError";
    }
}

/**
 * A turn Codex ended with `status: "failed"`, carrying that turn's `error` block.
 *
 * Emitted as an `error` stream part, because a failed turn otherwise reaches the consumer as
 * nothing but a `finishReason` — leaving an out-of-usage turn indistinguishable from a model that
 * simply said nothing, since both arrive as a turn with no content.
 *
 * `codexErrorInfo` is the machine-readable class (`"usageLimitExceeded"`,
 * `"contextWindowExceeded"`, `"unauthorized"`, …), and is the field to branch on: the `message` is
 * human-facing prose that may be reworded upstream at any time. Which classes are worth retrying
 * is deliberately the consumer's call, not this package's — we report what Codex said.
 */
export class CodexTurnFailedError extends CodexProviderError
{
    /** Codex's error class for this failure, or null when it reported none. */
    readonly codexErrorInfo: CodexErrorInfo | null;

    /** Codex's supplementary detail, or null when it reported none. */
    readonly additionalDetails: string | null;

    constructor(error: TurnError)
    {
        super(error.message);
        this.name = "CodexTurnFailedError";
        this.codexErrorInfo = error.codexErrorInfo;
        this.additionalDetails = error.additionalDetails;
    }
}
