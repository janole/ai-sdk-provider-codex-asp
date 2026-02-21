import type { LanguageModelV3Prompt } from '@ai-sdk/provider';

import type { CodexTurnInputItem } from './types';

/**
 * Minimal POC mapper: flattens system and user text parts into a single text input item.
 */
export function mapPromptToTurnInput(prompt: LanguageModelV3Prompt): CodexTurnInputItem[] {
  const chunks: string[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case 'system': {
        const text = message.content.trim();
        if (text.length > 0) {
          chunks.push(text);
        }
        break;
      }

      case 'user': {
        for (const part of message.content) {
          if (part.type === 'text') {
            const text = part.text.trim();
            if (text.length > 0) {
              chunks.push(text);
            }
          }
        }
        break;
      }

      default:
        break;
    }
  }

  return [{ type: 'text', text: chunks.join('\n\n'), text_elements: [] }];
}
