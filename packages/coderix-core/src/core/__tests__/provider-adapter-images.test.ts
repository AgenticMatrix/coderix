import { describe, it, expect } from 'vitest';
import { toAnthropicMessages } from '../provider-adapter.js';
import type { ContentBlock, Message } from '../types.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TRUNCATED_PNG = Buffer.from(PNG_1X1, 'base64').subarray(0, 40).toString('base64');

function imageBlock(data: string): ContentBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  };
}

describe('toAnthropicMessages — image sanitisation', () => {
  it('drops a corrupt image inside a tool_result but keeps the valid one', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.png' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [imageBlock(PNG_1X1), imageBlock(TRUNCATED_PNG)],
          } as ContentBlock,
        ],
      },
    ];

    const { messages: apiMessages } = toAnthropicMessages(messages);
    const blocks = apiMessages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const result = blocks.find((b) => b.type === 'tool_result');
    expect(result).toBeTruthy();
    const parts = (result as { content: Array<{ type: string; text?: string }> }).content;
    expect(parts.filter((p) => p.type === 'image')).toHaveLength(1);
    expect(parts.some((p) => p.type === 'text' && (p.text ?? '').includes('损坏'))).toBe(true);
  });

  it('replaces a corrupt top-level image with text', () => {
    const messages: Message[] = [{ role: 'user', content: [imageBlock(TRUNCATED_PNG)] }];
    const { messages: apiMessages } = toAnthropicMessages(messages);
    const blocks = apiMessages.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && (b.text ?? '').includes('损坏'))).toBe(true);
  });
});
