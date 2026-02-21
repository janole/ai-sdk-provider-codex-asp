import type { AppServerClient } from "./client/app-server-client";
import { CodexProviderError } from "./errors";
import type {
    CodexToolCallRequestParams,
    CodexToolCallResult,
    CodexToolResultContentItem,
} from "./protocol/types";

export interface DynamicToolExecutionContext {
    threadId?: string;
    turnId?: string;
    callId?: string;
    toolName: string;
}

export type DynamicToolHandler = (
    args: unknown,
    context: DynamicToolExecutionContext,
) => Promise<CodexToolCallResult>;

export interface DynamicToolsDispatcherSettings {
    handlers?: Record<string, DynamicToolHandler>;
    timeoutMs?: number;
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

    constructor(settings: DynamicToolsDispatcherSettings = {}) 
    {
        this.timeoutMs = settings.timeoutMs ?? 30_000;

        if (settings.handlers) 
        {
            for (const [name, handler] of Object.entries(settings.handlers)) 
            {
                this.register(name, handler);
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
            return toTextResult("Dynamic tool call is missing the tool name.", false);
        }

        const handler = this.handlers.get(toolName);

        if (!handler) 
        {
            return toTextResult(`No dynamic tool handler registered for "${toolName}".`, false);
        }

        const context: DynamicToolExecutionContext = {
            toolName,
            ...(params.threadId ? { threadId: params.threadId } : {}),
            ...(params.turnId ? { turnId: params.turnId } : {}),
            ...(params.callId ? { callId: params.callId } : {}),
        };

        const args = params.arguments ?? params.input;

        try 
        {
            return await withTimeout(handler(args, context), this.timeoutMs);
        }
        catch (error) 
        {
            const message = error instanceof Error ? error.message : "Dynamic tool execution failed.";
            return toTextResult(message, false);
        }
    }
}
