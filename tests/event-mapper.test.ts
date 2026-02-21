import { describe, expect, it } from 'vitest';

import { CodexEventMapper } from '../src/protocol/event-mapper';

describe('CodexEventMapper', () => {
  it('maps assistant message lifecycle to text stream parts', () => {
    const mapper = new CodexEventMapper();

    const events = [
      { method: 'turn/started', params: { threadId: 'thr', turnId: 'turn' } },
      {
        method: 'item/started',
        params: { threadId: 'thr', turnId: 'turn', itemId: 'item1', itemType: 'assistantMessage' },
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'thr', turnId: 'turn', itemId: 'item1', delta: 'Hello' },
      },
      {
        method: 'item/completed',
        params: { threadId: 'thr', turnId: 'turn', itemId: 'item1', itemType: 'assistantMessage' },
      },
      {
        method: 'turn/completed',
        params: { threadId: 'thr', turnId: 'turn', status: 'completed' as const },
      },
    ];

    const parts = events.flatMap((event) => mapper.map(event));

    expect(parts).toEqual([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'item1' },
      { type: 'text-delta', id: 'item1', delta: 'Hello' },
      { type: 'text-end', id: 'item1' },
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
          outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined,
          },
        },
      },
    ]);
  });
});
