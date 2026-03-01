import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";

import type { CommandApprovalHandler, FileChangeApprovalHandler } from "./approvals";
import type { CodexTransport } from "./client/transport";
import type { StdioTransportSettings } from "./client/transport-stdio";
import type { WebSocketTransportSettings } from "./client/transport-websocket";
import type { DynamicToolDefinition, DynamicToolHandler } from "./dynamic-tools";
import type { AskForApproval, CodexThreadResumeResult, SandboxMode, SandboxPolicy } from "./protocol/types";

export interface CodexThreadDefaults
{
    cwd?: string;
    approvalPolicy?: AskForApproval;
    sandbox?: SandboxMode;
}

export interface CodexTurnDefaults
{
    cwd?: string;
    approvalPolicy?: AskForApproval;
    sandboxPolicy?: SandboxPolicy;
    model?: string;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
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

export interface CodexProviderSettings
{
    defaultModel?: string;
    /** MCP servers to make available to Codex (additive behavior TBD — needs empirical testing). */
    mcpServers?: Record<string, McpServerConfig>;
    clientInfo?: {
        name: string;
        version: string;
        title?: string;
    };
    experimentalApi?: boolean;
    transport?: {
        type?: "stdio" | "websocket";
        stdio?: StdioTransportSettings;
        websocket?: WebSocketTransportSettings;
    };
    defaultThreadSettings?: CodexThreadDefaults;
    defaultTurnSettings?: CodexTurnDefaults;
    compaction?: CodexCompactionSettings;
    transportFactory?: (signal?: AbortSignal) => CodexTransport;
    /** Tools with schema (description + inputSchema) advertised to Codex + local handlers. */
    tools?: Record<string, DynamicToolDefinition>;
    /** Legacy: handler-only tools, not advertised to Codex. Use `tools` for full schema support. */
    toolHandlers?: Record<string, DynamicToolHandler>;
    toolTimeoutMs?: number;
    /** Max time to wait for `turn/interrupt` response on abort. */
    interruptTimeoutMs?: number;
    approvals?: {
        onCommandApproval?: CommandApprovalHandler;
        onFileChangeApproval?: FileChangeApprovalHandler;
    };
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
    persistent?: {
        poolSize?: number;
        idleTimeoutMs?: number;
        scope?: "provider" | "global";
        key?: string;
    };
    /** Emit plan updates as tool-call/tool-result parts. Default: true. */
    emitPlanUpdates?: boolean;
}
