import { describe, expect, it, vi } from "vitest";

import type { JsonRpcMessage } from "../src/client/transport";
import { createCodexAppServer } from "../src/provider";
import { MockTransport } from "./helpers/mock-transport";

class ScriptedTransport extends MockTransport
{
    private approvalScenario: "command" | "fileChange" | "none" = "none";
    private approvalRequestId = 100;

    setApprovalScenario(scenario: "command" | "fileChange" | "none"): void
    {
        this.approvalScenario = scenario;
    }

    override async sendMessage(message: JsonRpcMessage): Promise<void>
    {
        await super.sendMessage(message);

        if (!("id" in message) || message.id === undefined || !("method" in message))
        {
            return;
        }

        if (message.method === "initialize")
        {
            this.emitMessage({ id: message.id, result: { serverInfo: { name: "codex", version: "test" } } });
            return;
        }

        if (message.method === "thread/start")
        {
            this.emitMessage({ id: message.id, result: { threadId: "thr_1" } });
            return;
        }

        if (message.method === "turn/start")
        {
            this.emitMessage({ id: message.id, result: { turnId: "turn_1" } });

            if (this.approvalScenario === "command")
            {
                queueMicrotask(() =>
                {
                    this.emitMessage({
                        method: "turn/started",
                        params: { threadId: "thr_1", turn: { id: "turn_1" } },
                    });

                    // Codex sends a server→client request for command approval
                    this.emitMessage({
                        id: this.approvalRequestId,
                        method: "item/commandExecution/requestApproval",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_cmd_1",
                            approvalId: "approval_1",
                            reason: "Needs outbound access",
                            networkApprovalContext: { host: "github.com", protocol: "https" },
                            command: "git push origin main",
                            cwd: "/repo",
                            commandActions: [{ type: "unknown", command: "git push origin main" }],
                            additionalPermissions: { network: true, fileSystem: null, macos: null },
                            proposedExecpolicyAmendment: ["git push *"],
                            proposedNetworkPolicyAmendments: [{ host: "github.com", action: "allow" }],
                        },
                    });
                });
            }
            else if (this.approvalScenario === "fileChange")
            {
                queueMicrotask(() =>
                {
                    this.emitMessage({
                        method: "turn/started",
                        params: { threadId: "thr_1", turn: { id: "turn_1" } },
                    });

                    this.emitMessage({
                        id: this.approvalRequestId,
                        method: "item/fileChange/requestApproval",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_fc_1",
                            reason: "Write to /etc/config",
                        },
                    });
                });
            }
            else
            {
                queueMicrotask(() =>
                {
                    this.emitMessage({
                        method: "turn/started",
                        params: { threadId: "thr_1", turn: { id: "turn_1" } },
                    });
                    this.emitMessage({
                        method: "item/started",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_1",
                            itemType: "assistantMessage",
                        },
                    });
                    this.emitMessage({
                        method: "item/agentMessage/delta",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_1",
                            delta: "Hello",
                        },
                    });
                    this.emitMessage({
                        method: "item/completed",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            itemId: "item_1",
                            itemType: "assistantMessage",
                        },
                    });
                    this.emitMessage({
                        method: "turn/completed",
                        params: {
                            threadId: "thr_1",
                            turnId: "turn_1",
                            status: "completed",
                        },
                    });
                });
            }
        }
    }

    /**
     * When we receive an approval response, continue the turn.
     */
    handleApprovalResponse(responseMessage: JsonRpcMessage): void
    {
        if ("id" in responseMessage && responseMessage.id === this.approvalRequestId && "result" in responseMessage)
        {
            // Approval was answered — continue the turn
            queueMicrotask(() =>
            {
                this.emitMessage({
                    method: "item/started",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        itemType: "assistantMessage",
                    },
                });
                this.emitMessage({
                    method: "item/agentMessage/delta",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        delta: "Done",
                    },
                });
                this.emitMessage({
                    method: "item/completed",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        itemId: "item_1",
                        itemType: "assistantMessage",
                    },
                });
                this.emitMessage({
                    method: "turn/completed",
                    params: {
                        threadId: "thr_1",
                        turnId: "turn_1",
                        status: "completed",
                    },
                });
            });
        }
    }
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]>
{
    const reader = stream.getReader();
    const parts: unknown[] = [];

    while (true)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        parts.push(value);
    }

    return parts;
}

describe("ApprovalsDispatcher", () =>
{
    it("declines command execution by default", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("command");

        // Intercept outgoing messages to continue the turn after approval response
        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            // No approvals callbacks → defaults to decline
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "push it" }] }],
        });

        const parts = await readAll(stream);

        // Should still complete the turn in this scripted transport flow.
        const textDeltas = (parts as { type: string; delta?: string }[]).filter(
            (p) => p.type === "text-delta",
        );
        expect(textDeltas).toHaveLength(1);
        expect(textDeltas[0]?.delta).toBe("Done");

        // Verify the approval response was sent with "decline"
        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse).toBeDefined();
        expect(approvalResponse?.result.decision).toBe("decline");
    });

    it("calls onCommandApproval callback and sends the decision", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("command");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const onCommandApproval = vi.fn().mockResolvedValue("decline");

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: {
                onCommandApproval,
            },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "push it" }] }],
        });

        await readAll(stream);

        expect(onCommandApproval).toHaveBeenCalledOnce();
        expect(onCommandApproval).toHaveBeenCalledWith({
            threadId: "thr_1",
            turnId: "turn_1",
            itemId: "item_cmd_1",
            approvalId: "approval_1",
            reason: "Needs outbound access",
            networkApprovalContext: { host: "github.com", protocol: "https" },
            command: "git push origin main",
            cwd: "/repo",
            commandActions: [{ type: "unknown", command: "git push origin main" }],
            additionalPermissions: { network: true, fileSystem: null, macos: null },
            proposedExecpolicyAmendment: ["git push *"],
            proposedNetworkPolicyAmendments: [{ host: "github.com", action: "allow" }],
        });

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse?.result.decision).toBe("decline");
    });

    it("calls onFileChangeApproval callback and sends the decision", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("fileChange");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const onFileChangeApproval = vi.fn().mockResolvedValue("accept");

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            approvals: {
                onFileChangeApproval,
            },
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "write config" }] }],
        });

        await readAll(stream);

        expect(onFileChangeApproval).toHaveBeenCalledOnce();
        expect(onFileChangeApproval).toHaveBeenCalledWith({
            threadId: "thr_1",
            turnId: "turn_1",
            itemId: "item_fc_1",
            reason: "Write to /etc/config",
        });

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse?.result.decision).toBe("accept");
    });

    it("declines file changes by default", async () =>
    {
        const transport = new ScriptedTransport();
        transport.setApprovalScenario("fileChange");

        const originalSendMessage = transport.sendMessage.bind(transport);
        transport.sendMessage = async (message: JsonRpcMessage) =>
        {
            await originalSendMessage(message);
            transport.handleApprovalResponse(message);
        };

        const provider = createCodexAppServer({
            transportFactory: () => transport,
            clientInfo: { name: "test-client", version: "1.0.0" },
            // No approvals callbacks → defaults to decline
        });

        const model = provider.languageModel("gpt-5.3-codex");

        const { stream } = await model.doStream({
            prompt: [{ role: "user", content: [{ type: "text", text: "write config" }] }],
        });

        const parts = await readAll(stream);

        const textDeltas = (parts as { type: string; delta?: string }[]).filter(
            (p) => p.type === "text-delta",
        );
        expect(textDeltas).toHaveLength(1);
        expect(textDeltas[0]?.delta).toBe("Done");

        const approvalResponse = transport.sentMessages.find(
            (msg) => "id" in msg && msg.id === 100 && "result" in msg,
        ) as { id: number; result: { decision: string } } | undefined;

        expect(approvalResponse?.result.decision).toBe("decline");
    });
});
