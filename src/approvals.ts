import type { AppServerClient } from "./client/app-server-client";
import type { JsonRpcRequest } from "./client/transport";
import type {
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeApprovalDecision,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
    McpServerElicitationRequestParams,
    McpServerElicitationRequestResponse,
    PermissionsRequestApprovalResponse,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
} from "./protocol/types";

export type CodexCommandApprovalRequest = CommandExecutionRequestApprovalParams;
export type CodexFileChangeApprovalRequest = FileChangeRequestApprovalParams;
export type CodexToolUserInputRequest = ToolRequestUserInputParams;
export type CodexElicitationRequest = McpServerElicitationRequestParams;

export type CommandApprovalHandler = (
    request: CodexCommandApprovalRequest,
) => CommandExecutionApprovalDecision | Promise<CommandExecutionApprovalDecision>;

export type FileChangeApprovalHandler = (
    request: CodexFileChangeApprovalRequest,
) => FileChangeApprovalDecision | Promise<FileChangeApprovalDecision>;

export type ToolUserInputHandler = (
    request: CodexToolUserInputRequest,
) => ToolRequestUserInputResponse | Promise<ToolRequestUserInputResponse>;

export type ElicitationHandler = (
    request: CodexElicitationRequest,
) => McpServerElicitationRequestResponse | Promise<McpServerElicitationRequestResponse>;

export interface ApprovalsDispatcherSettings {
    onCommandApproval?: CommandApprovalHandler;
    onFileChangeApproval?: FileChangeApprovalHandler;
    onToolUserInput?: ToolUserInputHandler;
    onElicitation?: ElicitationHandler;
}

function defaultToolUserInputHandler(params: ToolRequestUserInputParams): ToolRequestUserInputResponse
{
    const answers: ToolRequestUserInputResponse["answers"] = {};
    for (const q of params.questions)
    {
        const first = q.options?.[0];
        answers[q.id] = { answers: first ? [first.label] : [] };
    }
    return { answers };
}

export class ApprovalsDispatcher
{
    private readonly onCommandApproval: CommandApprovalHandler;
    private readonly onFileChangeApproval: FileChangeApprovalHandler;
    private readonly onToolUserInput: ToolUserInputHandler;
    private readonly onElicitation: ElicitationHandler;

    constructor(settings: ApprovalsDispatcherSettings = {})
    {
        this.onCommandApproval = settings.onCommandApproval ?? (() => "decline");
        this.onFileChangeApproval = settings.onFileChangeApproval ?? (() => "decline");
        this.onToolUserInput = settings.onToolUserInput ?? defaultToolUserInputHandler;
        this.onElicitation = settings.onElicitation
            ?? (() => ({ action: "accept", content: null, _meta: null } satisfies McpServerElicitationRequestResponse));
    }

    attach(client: AppServerClient): () => void
    {
        const unsubCommand = client.onRequest(
            "item/commandExecution/requestApproval",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                const decision = await this.onCommandApproval(params as CodexCommandApprovalRequest);
                return { decision } satisfies CommandExecutionRequestApprovalResponse;
            },
        );

        const unsubFileChange = client.onRequest(
            "item/fileChange/requestApproval",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                const decision = await this.onFileChangeApproval(params as CodexFileChangeApprovalRequest);
                return { decision } satisfies FileChangeRequestApprovalResponse;
            },
        );

        const unsubToolUserInput = client.onRequest(
            "item/tool/requestUserInput",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                return await this.onToolUserInput(params as CodexToolUserInputRequest) satisfies ToolRequestUserInputResponse;
            },
        );

        const unsubPermissions = client.onRequest(
            "item/permissions/requestApproval",
            (_params: unknown, _request: JsonRpcRequest) =>
            {
                return { permissions: {}, scope: "turn" } satisfies PermissionsRequestApprovalResponse;
            },
        );

        const unsubElicitation = client.onRequest(
            "mcpServer/elicitation/request",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                return await this.onElicitation(params as CodexElicitationRequest) satisfies McpServerElicitationRequestResponse;
            },
        );

        return () =>
        {
            unsubCommand();
            unsubFileChange();
            unsubToolUserInput();
            unsubPermissions();
            unsubElicitation();
        };
    }
}
