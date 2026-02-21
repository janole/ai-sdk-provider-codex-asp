import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';

import { CodexLanguageModel } from '../src/model';

function streamFromParts(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

class MockGenerateModel extends CodexLanguageModel {
  constructor(private readonly result: LanguageModelV3StreamResult) {
    super('gpt-5.1-codex', {}, { provider: 'codex-app-server', providerSettings: {} });
  }

  override async doStream(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    return this.result;
  }
}

const baseOptions: LanguageModelV3CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};

describe('CodexLanguageModel.doGenerate', () => {
  it('aggregates text deltas and keeps tool events in content', async () => {
    const model = new MockGenerateModel({
      stream: streamFromParts([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'txt1' },
        { type: 'text-delta', id: 'txt1', delta: 'Hel' },
        { type: 'text-delta', id: 'txt1', delta: 'lo' },
        {
          type: 'tool-call',
          toolCallId: 'tool-1',
          toolName: 'lookup',
          input: '{"id":"1"}',
        },
        {
          type: 'tool-result',
          toolCallId: 'tool-1',
          toolName: 'lookup',
          result: { ok: true },
        },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'completed' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
        },
      ]),
      request: { body: { test: true } },
    });

    const result = await model.doGenerate(baseOptions);

    expect(result.content).toEqual([
      { type: 'text', text: 'Hello' },
      {
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'lookup',
        input: '{"id":"1"}',
      },
      {
        type: 'tool-result',
        toolCallId: 'tool-1',
        toolName: 'lookup',
        result: { ok: true },
      },
    ]);
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'completed' });
    expect(result.usage).toEqual({
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    });
    expect(result.request).toEqual({ body: { test: true } });
    expect(result.warnings).toEqual([]);
  });

  it('returns empty content when no text/tool content is generated', async () => {
    const model = new MockGenerateModel({
      stream: streamFromParts([
        { type: 'stream-start', warnings: [] },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'completed' },
          usage: {
            inputTokens: {
              total: undefined,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: undefined, text: undefined, reasoning: undefined },
          },
        },
      ]),
    });

    const result = await model.doGenerate(baseOptions);
    expect(result.content).toEqual([]);
  });

  it('propagates stream error parts as thrown errors', async () => {
    const model = new MockGenerateModel({
      stream: streamFromParts([
        { type: 'stream-start', warnings: [] },
        { type: 'error', error: new Error('kaboom') },
      ]),
    });

    await expect(model.doGenerate(baseOptions)).rejects.toThrow('kaboom');
  });
});
