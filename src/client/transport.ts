export type JsonRpcId = string | number;

export interface JsonRpcRequest {
    id: JsonRpcId;
    method: string;
    params?: unknown;
}

export interface JsonRpcNotification {
    method: string;
    params?: unknown;
}

export interface JsonRpcSuccessResponse {
    id: JsonRpcId;
    result: unknown;
}

export interface JsonRpcErrorResponse {
    id: JsonRpcId;
    error: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export type CodexTransportEventMap = {
    message: (message: JsonRpcMessage) => void;
    error: (error: unknown) => void;
    close: (code: number | null, signal: NodeJS.Signals | null) => void;
};

export interface CodexTransport {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    sendMessage(message: JsonRpcMessage): Promise<void>;
    sendNotification(method: string, params?: unknown): Promise<void>;
    on<K extends keyof CodexTransportEventMap>(
        event: K,
        listener: CodexTransportEventMap[K],
    ): () => void;
}
