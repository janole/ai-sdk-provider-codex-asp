/** Base error type for this provider package. */
export class CodexProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CodexProviderError';
  }
}

/** Error used for methods intentionally left as stubs in early PRs. */
export class CodexNotImplementedError extends CodexProviderError {
  constructor(method: string) {
    super(`Codex provider method not implemented yet: ${method}`);
    this.name = 'CodexNotImplementedError';
  }
}
