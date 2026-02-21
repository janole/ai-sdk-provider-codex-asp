import { NoSuchModelError } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';

import { CodexLanguageModel } from '../src/model';
import { createCodexAppServer } from '../src/provider';

describe('createCodexAppServer', () => {
  it('creates provider with v3 specification and language model factory', () => {
    const provider = createCodexAppServer({
      clientInfo: { name: 'test', version: '0.1.0' },
      experimentalApi: true,
    });

    expect(provider.specificationVersion).toBe('v3');

    const model = provider.languageModel('gpt-5.1-codex');
    expect(model).toBeInstanceOf(CodexLanguageModel);
    expect(model.specificationVersion).toBe('v3');
    expect(model.provider).toBe('codex-app-server');
    expect(model.modelId).toBe('gpt-5.1-codex');
  });

  it('supports callable provider and chat alias', () => {
    const provider = createCodexAppServer();

    const viaCall = provider('gpt-5.1-codex');
    const viaChat = provider.chat('gpt-5.1-codex');

    expect(viaCall).toBeInstanceOf(CodexLanguageModel);
    expect(viaChat).toBeInstanceOf(CodexLanguageModel);
  });

  it('throws NoSuchModelError for embedding and image models', () => {
    const provider = createCodexAppServer();

    expect(() => provider.embeddingModel('embed-model')).toThrowError(
      NoSuchModelError,
    );
    expect(() => provider.imageModel('image-model')).toThrowError(
      NoSuchModelError,
    );
  });
});
