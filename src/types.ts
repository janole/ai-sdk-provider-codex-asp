export interface CodexProviderConfig {
    /** Base URL of the Codex App Server Protocol endpoint. */
    baseUrl: string;
    /** Optional API key used for authenticating requests. */
    apiKey?: string;
    /** Optional custom headers merged into outgoing requests. */
    headers?: Record<string, string>;
}

export interface CodexProvider {
    /** Provider name used for diagnostics and identification. */
    readonly name: "codex-ai-sdk-provider";
    /** Immutable provider configuration. */
    readonly config: Readonly<CodexProviderConfig>;
}

export interface CodexStreamChunk {
    type: "delta" | "done" | "error";
    content?: string;
    error?: string;
}
