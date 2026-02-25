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
import { stripUndefined } from "./utils/object";

export interface CodexCommandApprovalRequest {
    threadId: string;
    turnId: string;
    itemId: string;
    approvalId?: string | null;
    reason?: string | null;
    networkApprovalContext?: CommandExecutionRequestApprovalParams["networkApprovalContext"];
    command?: string | null;
    cwd?: string | null;
    commandActions?: CommandExecutionRequestApprovalParams["commandActions"];
    additionalPermissions?: CommandExecutionRequestApprovalParams["additionalPermissions"];
    proposedExecpolicyAmendment?: CommandExecutionRequestApprovalParams["proposedExecpolicyAmendment"];
    proposedNetworkPolicyAmendments?: CommandExecutionRequestApprovalParams["proposedNetworkPolicyAmendments"];
}

export interface CodexFileChangeApprovalRequest {
    threadId: string;
    turnId: string;
    itemId: string;
    reason?: string | null;
    grantRoot?: string | null;
}

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
                const p = params as CommandExecutionRequestApprovalParams;
                const request: CodexCommandApprovalRequest = stripUndefined({
                    threadId: p.threadId,
                    turnId: p.turnId,
                    itemId: p.itemId,
                    approvalId: p.approvalId,
                    reason: p.reason,
                    networkApprovalContext: p.networkApprovalContext,
                    command: p.command,
                    cwd: p.cwd,
                    commandActions: p.commandActions,
                    additionalPermissions: p.additionalPermissions,
                    proposedExecpolicyAmendment: p.proposedExecpolicyAmendment,
                    proposedNetworkPolicyAmendments: p.proposedNetworkPolicyAmendments,
                });

                const decision = await this.onCommandApproval(request);
                return { decision } satisfies CommandExecutionRequestApprovalResponse;
            },
        );

        const unsubFileChange = client.onRequest(
            "item/fileChange/requestApproval",
            async (params: unknown, _request: JsonRpcRequest) =>
            {
                const p = params as FileChangeRequestApprovalParams;
                const request: CodexFileChangeApprovalRequest = stripUndefined({
                    threadId: p.threadId,
                    turnId: p.turnId,
                    itemId: p.itemId,
                    reason: p.reason,
                    grantRoot: p.grantRoot,
                });

                const decision = await this.onFileChangeApproval(request);
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
