import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

import type { CommandApprovalHandler, FileChangeApprovalHandler } from "./approvals";
import type { CodexTransport } from "./client/transport";
import type { StdioTransportSettings } from "./client/transport-stdio";
import type { WebSocketTransportSettings } from "./client/transport-websocket";
import type { DynamicToolDefinition, DynamicToolHandler } from "./dynamic-tools";
import type { AskForApproval, CodexThreadResumeResult, SandboxMode, SandboxPolicy } from "./protocol/types";
import type { CodexSession } from "./session";

export interface TransportContext
{
    signal?: AbortSignal;
    threadId?: string;
}

/** Default settings applied when starting a new thread. */
export interface CodexThreadDefaults
{
    /** Working directory for the thread. */
    cwd?: string;
    /** Tool-use approval policy — `"never"` | `"on-failure"` | `"on-request"` | `"untrusted"` | `{ granular: … }`. See {@link AskForApproval}. */
    approvalPolicy?: AskForApproval;
    /** Sandbox mode — `"read-only"` | `"workspace-write"` | `"danger-full-access"`. See {@link SandboxMode}. */
    sandbox?: SandboxMode;
}

/** Default settings applied to every turn. */
export interface CodexTurnDefaults
{
    /** Working directory for the turn (overrides thread-level `cwd`). */
    cwd?: string;
    /** Tool-use approval policy for this turn. */
    approvalPolicy?: AskForApproval;
    /** Fine-grained sandbox policy — `{ type: "dangerFullAccess" }` | `{ type: "readOnly", … }` | `{ type: "workspaceWrite", … }` | `{ type: "externalSandbox", … }`. See {@link SandboxPolicy}. */
    sandboxPolicy?: SandboxPolicy;
    /** Model to use for this turn (overrides provider-level `defaultModel`). */
    model?: string;
    /** How much effort the model should spend on the response. */
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    /** Controls turn summary generation. */
    summary?: "auto" | "concise" | "detailed" | "none";
}

/**
 * Per-call overrides passed via `providerOptions[CODEX_PROVIDER_ID]` in
 * `streamText()` / `generateText()`. Values here take precedence over
 * `defaultThreadSettings` and `defaultTurnSettings` from the provider.
 */
export interface CodexCallOptions
{
    // — Thread-level (applied to thread/start and thread/resume) —

    /** Working directory for this call. Also sent as turn-level `cwd`. */
    cwd?: string;
    /** Tool-use approval policy — `"never"` | `"on-failure"` | `"on-request"` | `"untrusted"` | `{ granular: … }`. See {@link AskForApproval}. */
    approvalPolicy?: AskForApproval;
    /** Sandbox mode — `"read-only"` | `"workspace-write"` | `"danger-full-access"`. See {@link SandboxMode}. */
    sandbox?: SandboxMode;

    // — Turn-level —

    /** How much effort the model should spend on the response. */
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    /** Model to use for this turn. */
    model?: string;
    /** Fine-grained sandbox policy — `{ type: "dangerFullAccess" }` | `{ type: "readOnly", … }` | `{ type: "workspaceWrite", … }` | `{ type: "externalSandbox", … }`. See {@link SandboxPolicy}. */
    sandboxPolicy?: SandboxPolicy;
    /** Controls turn summary generation. */
    summary?: "auto" | "concise" | "detailed" | "none";
}

export interface CodexCompactionSettings
{
    /**
     * Trigger `thread/compact/start` before `turn/start` when resuming a thread.
     * Off by default.
     */
    shouldCompactOnResume?: CodexCompactionOnResumeDecision;
    /**
     * When false (default), compaction errors are ignored and the turn continues.
     * When true, compaction errors fail the request.
     */
    strict?: boolean;
}

export interface CodexCompactionOnResumeContext
{
    threadId: string;
    resumeThreadId: string;
    resumeResult: CodexThreadResumeResult;
    prompt: LanguageModelV3CallOptions["prompt"];
}

export type CodexCompactionOnResumeDecision =
    | boolean
    | ((context: CodexCompactionOnResumeContext) => boolean | Promise<boolean>);

export type McpServerConfig =
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { type: "http"; url: string; bearerToken?: string; headers?: Record<string, string> };

/** Settings for the Codex provider, passed to `createCodexAppServer()`. */
export interface CodexProviderSettings
{
    /** Model ID used when none is specified per-call (e.g. `"o4-mini"`). */
    defaultModel?: string;
    /** MCP servers to make available to Codex. */
    mcpServers?: Record<string, McpServerConfig>;
    /** Identifies the client application to the Codex server. */
    clientInfo?: {
        name: string;
        version: string;
        title?: string;
    };
    /** Enable experimental / unstable API features. */
    experimentalApi?: boolean;
    /** Transport layer configuration (stdio or websocket). */
    transport?: {
        type?: "stdio" | "websocket";
        stdio?: StdioTransportSettings;
        websocket?: WebSocketTransportSettings;
    };
    /** Defaults applied when starting a new thread (can be overridden per-call via `codexCallOptions()`). */
    defaultThreadSettings?: CodexThreadDefaults;
    /** Defaults applied to every turn (can be overridden per-call via `codexCallOptions()`). */
    defaultTurnSettings?: CodexTurnDefaults;
    /** Controls automatic thread compaction on resume. */
    compaction?: CodexCompactionSettings;
    /** Custom factory for creating transport instances (advanced). */
    transportFactory?: (context: TransportContext) => CodexTransport;
    /** Tools with schema (description + inputSchema) advertised to Codex + local handlers. */
    tools?: Record<string, DynamicToolDefinition>;
    /** Legacy: handler-only tools, not advertised to Codex. Use `tools` for full schema support. */
    toolHandlers?: Record<string, DynamicToolHandler>;
    /** Max time (ms) to wait for a dynamic tool call to complete. */
    toolTimeoutMs?: number;
    /** Max time (ms) to wait for `turn/interrupt` response on abort. */
    interruptTimeoutMs?: number;
    /** Callbacks invoked when Codex requests approval for commands or file changes. */
    approvals?: {
        onCommandApproval?: CommandApprovalHandler;
        onFileChangeApproval?: FileChangeApprovalHandler;
    };
    /** Diagnostic logging options. */
    debug?: {
        /** Log all JSON-RPC packets exchanged with Codex. */
        logPackets?: boolean;
        /** Optional packet logger (defaults to console.debug for inbound packets). */
        logger?: (packet: {
            direction: "inbound" | "outbound";
            message: unknown;
        }) => void;
        /** Log dynamic tool registration, calls, and responses. */
        logToolCalls?: boolean;
        /** Optional dynamic tool logger (defaults to console.debug). */
        toolLogger?: (event: {
            event: string;
            data?: unknown;
        }) => void;
    };
    /** Keep Codex processes alive across calls for faster subsequent turns. */
    persistent?: {
        /** Number of worker processes to keep in the pool. */
        poolSize?: number;
        /** Time (ms) before an idle worker is shut down. */
        idleTimeoutMs?: number;
        /** `"provider"` = pool per provider instance; `"global"` = shared across all instances. */
        scope?: "provider" | "global";
        /** Custom key for pool deduplication (only with `scope: "global"`). */
        key?: string;
    };
    /** Emit plan updates as tool-call/tool-result parts. Default: true. */
    emitPlanUpdates?: boolean;
    /** Called when a streaming session is created, providing access to inject messages and interrupt. */
    onSessionCreated?: (session: CodexSession) => void;
}
