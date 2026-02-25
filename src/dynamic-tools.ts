import type { AppServerClient } from "./client/app-server-client";
import { CodexProviderError } from "./errors";
import type {
    CodexToolCallRequestParams,
    CodexToolCallResult,
    CodexToolResultContentItem,
} from "./protocol/types";
import { stripUndefined } from "./utils/object";

export interface DynamicToolExecutionContext
{
    threadId?: string;
    turnId?: string;
    callId?: string;
    toolName: string;
}

export type DynamicToolHandler = (
    args: unknown,
    context: DynamicToolExecutionContext,
) => Promise<CodexToolCallResult>;

/** Full tool definition: schema advertised to Codex + local execution handler. */
export interface DynamicToolDefinition
{
    description: string;
    inputSchema: Record<string, unknown>;
    execute: DynamicToolHandler;
}

export interface DynamicToolsDispatcherSettings
{
    /** Tools with full schema advertised to Codex. Handlers are registered automatically. */
    tools?: Record<string, DynamicToolDefinition>;
    /** Legacy handler-only registration (no schema). Tools are not advertised to Codex. */
    handlers?: Record<string, DynamicToolHandler>;
    timeoutMs?: number;
    onDebugEvent?: (event: {
        event: string;
        data?: unknown;
    }) => void;
}

function toTextResult(message: string, success: boolean): CodexToolCallResult 
{
    const contentItems: CodexToolResultContentItem[] = [{ type: "inputText", text: message }];
    return { success, contentItems };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> 
{
    return new Promise<T>((resolve, reject) => 
    {
        const timer = setTimeout(() => 
        {
            reject(new CodexProviderError(`Dynamic tool execution timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        promise
            .then((value) => 
            {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((error) =>
            {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            });
    });
}

export class DynamicToolsDispatcher 
{
    private readonly handlers = new Map<string, DynamicToolHandler>();
    private readonly timeoutMs: number;
    private readonly onDebugEvent?: DynamicToolsDispatcherSettings["onDebugEvent"];

    constructor(settings: DynamicToolsDispatcherSettings = {})
    {
        this.timeoutMs = settings.timeoutMs ?? 30_000;
        this.onDebugEvent = settings.onDebugEvent;

        if (settings.tools)
        {
            for (const [name, def] of Object.entries(settings.tools))
            {
                this.register(name, def.execute);
                this.onDebugEvent?.({
                    event: "dynamic-tool-registered",
                    data: { name, source: "tools" },
                });
            }
        }

        if (settings.handlers)
        {
            for (const [name, handler] of Object.entries(settings.handlers))
            {
                this.register(name, handler);
                this.onDebugEvent?.({
                    event: "dynamic-tool-registered",
                    data: { name, source: "handlers" },
                });
            }
        }
    }

    register(name: string, handler: DynamicToolHandler): void 
    {
        this.handlers.set(name, handler);
    }

    attach(client: AppServerClient): () => void 
    {
        return client.onToolCallRequest(async (params) => this.dispatch(params));
    }

    async dispatch(params: CodexToolCallRequestParams): Promise<CodexToolCallResult> 
    {
        const toolName = params.tool ?? params.toolName;

        if (!toolName) 
        {
            this.onDebugEvent?.({
                event: "dynamic-tool-missing-name",
                data: {
                    callId: params.callId,
                    threadId: params.threadId,
                    turnId: params.turnId,
                },
            });
            return toTextResult("Dynamic tool call is missing the tool name.", false);
        }

        const handler = this.handlers.get(toolName);

        if (!handler) 
        {
            this.onDebugEvent?.({
                event: "dynamic-tool-missing-handler",
                data: {
                    toolName,
                    callId: params.callId,
                    threadId: params.threadId,
                    turnId: params.turnId,
                },
            });
            return toTextResult(`No dynamic tool handler registered for "${toolName}".`, false);
        }

        const context: DynamicToolExecutionContext = stripUndefined({
            toolName,
            threadId: params.threadId,
            turnId: params.turnId,
            callId: params.callId,
        });

        const args = params.arguments ?? params.input;
        const startedAt = Date.now();

        this.onDebugEvent?.({
            event: "dynamic-tool-dispatch-start",
            data: {
                toolName,
                callId: params.callId,
                threadId: params.threadId,
                turnId: params.turnId,
                hasArguments: args !== undefined,
            },
        });

        try 
        {
            const result = await withTimeout(handler(args, context), this.timeoutMs);

            this.onDebugEvent?.({
                event: "dynamic-tool-dispatch-success",
                data: {
                    toolName,
                    callId: params.callId,
                    durationMs: Date.now() - startedAt,
                    success: result.success,
                    contentItemsCount: result.contentItems.length,
                },
            });

            return result;
        }
        catch (error) 
        {
            const message = error instanceof Error ? error.message : "Dynamic tool execution failed.";

            this.onDebugEvent?.({
                event: "dynamic-tool-dispatch-error",
                data: {
                    toolName,
                    callId: params.callId,
                    durationMs: Date.now() - startedAt,
                    message,
                },
            });

            return toTextResult(message, false);
        }
    }
}
