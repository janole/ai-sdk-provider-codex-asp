/**
 * Hand-maintained subset of the Codex app-server protocol types.
 *
 * Only includes types this provider actively uses. When adding new types,
 * check the full generated set first:
 *
 *   npm run codex:generate-types
 *
 * The generated types land in src/protocol/app-server-protocol/ (gitignored)
 * and serve as the authoritative reference. V2 types (camelCase) are in the v2/ subdirectory.
 */
import type { AskForApproval } from "./app-server-protocol/v2/AskForApproval";
import type { SandboxMode } from "./app-server-protocol/v2/SandboxMode";

export type { AskForApproval };
export type { SandboxMode };

export interface JsonRpcMessageBase {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export interface CodexInitializeParams {
    clientInfo: {
        name: string;
        version: string;
        title?: string;
    };
    capabilities?: {
        experimentalApi?: boolean;
    };
}

export interface CodexInitializeResult {
    serverInfo?: {
        name: string;
        version: string;
    };
}

export interface CodexInitializedNotification {
    method: "initialized";
    params?: Record<string, never>;
}

export interface CodexDynamicToolDefinition {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}

export interface CodexThreadStartParams {
    model?: string;
    cwd?: string;
    approvalPolicy?: AskForApproval;
    sandbox?: SandboxMode;
    dynamicTools?: CodexDynamicToolDefinition[];
}

export interface CodexThreadStartResult {
    threadId: string;
    tools?: CodexDynamicToolDefinition[];
}

export interface CodexThreadResumeParams {
    threadId: string;
    persistExtendedHistory: boolean;
}

export interface CodexThreadResumeResult {
    thread?: {
        id?: string;
    };
    threadId?: string;
}

export interface CodexTurnInputText {
    type: "text";
    text: string;
    text_elements: Array<{
        start: number;
        end: number;
        type: "mention" | "skill";
    }>;
}

export interface CodexTurnInputImage {
    type: "image";
    url: string;
}

export interface CodexTurnInputLocalImage {
    type: "localImage";
    path: string;
}

export interface CodexTurnInputSkill {
    type: "skill";
    name: string;
    path: string;
}

export interface CodexTurnInputMention {
    type: "mention";
    name: string;
    path: string;
}

export type CodexTurnInputItem =
  | CodexTurnInputText
  | CodexTurnInputImage
  | CodexTurnInputLocalImage
  | CodexTurnInputSkill
  | CodexTurnInputMention;

export interface CodexTurnStartParams {
    threadId: string;
    input: CodexTurnInputItem[];
}

export interface CodexTurnStartResult {
    turnId: string;
}

export interface CodexTurnStartedNotification {
    method: "turn/started";
    params: {
        threadId: string;
        turnId: string;
    };
}

export interface CodexTurnCompletedNotification {
    method: "turn/completed";
    params: {
        threadId: string;
        turnId: string;
        status: "completed" | "interrupted" | "failed";
    };
}

export interface CodexItemStartedNotification {
    method: "item/started";
    params: {
        threadId: string;
        turnId: string;
        itemId: string;
        itemType: string;
    };
}

export interface CodexItemCompletedNotification {
    method: "item/completed";
    params: {
        threadId: string;
        turnId: string;
        itemId: string;
        itemType: string;
    };
}

export interface CodexAgentMessageDeltaNotification {
    method: "item/agentMessage/delta";
    params: {
        threadId: string;
        turnId: string;
        itemId: string;
        delta: string;
    };
}

export interface CodexToolCallStartedNotification {
    method: "item/tool/callStarted";
    params: {
        callId: string;
        tool: string;
    };
}

export interface CodexToolCallDeltaNotification {
    method: "item/tool/callDelta";
    params: {
        callId: string;
        delta: string;
    };
}

export interface CodexToolCallFinishedNotification {
    method: "item/tool/callFinished";
    params: {
        callId: string;
    };
}

export interface CodexToolCallRequestParams {
    threadId?: string;
    turnId?: string;
    callId?: string;
    tool?: string;
    toolName?: string;
    arguments?: unknown;
    input?: unknown;
}

export type CodexToolResultContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export interface CodexToolCallResult {
    success: boolean;
    contentItems: CodexToolResultContentItem[];
}

export type CodexNotification =
  | CodexInitializedNotification
  | CodexTurnStartedNotification
  | CodexTurnCompletedNotification
  | CodexItemStartedNotification
  | CodexItemCompletedNotification
  | CodexAgentMessageDeltaNotification
  | CodexToolCallStartedNotification
  | CodexToolCallDeltaNotification
  | CodexToolCallFinishedNotification;
