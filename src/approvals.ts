import type { AppServerClient } from "./client/app-server-client";
import type { JsonRpcRequest } from "./client/transport";
import type {
    CommandExecutionApprovalDecision,
    CommandExecutionRequestApprovalParams,
    CommandExecutionRequestApprovalResponse,
    FileChangeApprovalDecision,
    FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse,
} from "./protocol/types";

export type CodexCommandApprovalRequest = CommandExecutionRequestApprovalParams;
export type CodexFileChangeApprovalRequest = FileChangeRequestApprovalParams;

export type CommandApprovalHandler = (
    request: CodexCommandApprovalRequest,
) => CommandExecutionApprovalDecision | Promise<CommandExecutionApprovalDecision>;

export type FileChangeApprovalHandler = (
    request: CodexFileChangeApprovalRequest,
) => FileChangeApprovalDecision | Promise<FileChangeApprovalDecision>;

export interface ApprovalsDispatcherSettings {
    onCommandApproval?: CommandApprovalHandler;
    onFileChangeApproval?: FileChangeApprovalHandler;
}

export class ApprovalsDispatcher
{
    private readonly onCommandApproval: CommandApprovalHandler;
    private readonly onFileChangeApproval: FileChangeApprovalHandler;

    constructor(settings: ApprovalsDispatcherSettings = {})
    {
        this.onCommandApproval = settings.onCommandApproval ?? (() => "decline");
        this.onFileChangeApproval = settings.onFileChangeApproval ?? (() => "decline");
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

        return () =>
        {
            unsubCommand();
            unsubFileChange();
        };
    }
}
