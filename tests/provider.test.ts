import { describe, expect, it } from 'vitest';

import { createCodexProvider } from '../src/provider';

describe('createCodexProvider', () => {
  it('creates provider with immutable config', () => {
    const provider = createCodexProvider({
      baseUrl: 'https://api.example.com',
      headers: { 'x-test': '1' },
    });

    expect(provider.name).toBe('codex-ai-sdk-provider');
    expect(provider.config.baseUrl).toBe('https://api.example.com');
    expect(Object.isFrozen(provider.config)).toBe(true);
  });

  it('throws when baseUrl is missing', () => {
    expect(() => createCodexProvider({ baseUrl: '   ' })).toThrow(/baseUrl/i);
  });
});
