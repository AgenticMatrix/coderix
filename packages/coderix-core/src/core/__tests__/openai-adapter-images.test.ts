import { describe, it, expect } from 'vitest';
import { toOpenAIMessages } from '../openai-adapter.js';
import type { ContentBlock, Message } from '../types.js';

// A real 1x1 PNG: the adapters pass bytes through, but using a decodable
// payload keeps this fixture honest about what the provider would accept.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageBlock(data = PNG_1X1, mediaType = 'image/png'): ContentBlock {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

describe('toOpenAIMessages — inline images', () => {
  it('maps an image block to an image_url data URL ahead of the text', () => {
    const messages: Message[] = [
      { role: 'user', content: [imageBlock(), { type: 'text', text: '这张图是什么？' }] },
    ];

    const [user] = toOpenAIMessages('', messages);
    expect(Array.isArray(user!.content)).toBe(true);
    const parts = user!.content as Array<Record<string, any>>;
    expect(parts[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG_1X1}` },
    });
    expect(parts[1]).toEqual({ type: 'text', text: '这张图是什么？' });
  });

  it('keeps the payload media type on the data URL', () => {
    const messages: Message[] = [
      { role: 'user', content: [imageBlock(PNG_1X1, 'image/webp')] },
    ];

    const parts = toOpenAIMessages('', messages)[0]!.content as Array<Record<string, any>>;
    expect(parts[0]!.image_url.url).toBe(`data:image/webp;base64,${PNG_1X1}`);
  });

  it('emits an image-only multipart message when there is no text', () => {
    const messages: Message[] = [{ role: 'user', content: [imageBlock()] }];

    const parts = toOpenAIMessages('', messages)[0]!.content as Array<Record<string, any>>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.type).toBe('image_url');
  });

  it('still sends plain text as a string (no regression for text-only turns)', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }];

    expect(toOpenAIMessages('', messages)[0]!.content).toBe('hello');
  });

  it('skips an image block with no payload instead of emitting an empty URL', () => {
    const messages: Message[] = [
      { role: 'user', content: [imageBlock(''), { type: 'text', text: 'hi' }] },
    ];

    const user = toOpenAIMessages('', messages)[0]!;
    // No usable image → the text-only string form wins.
    expect(user.content).toBe('hi');
  });
});

describe('toOpenAIMessages — images inside a tool_result', () => {
  // The Read tool returns an image as [text placeholder, image block]; Chat
  // Completions' `role: "tool"` message takes only a string, so the pixels have
  // to follow in a user turn or the model never sees them.
  const TRUNCATED_PNG = Buffer.from(PNG_1X1, 'base64').subarray(0, 40).toString('base64');
  const DATA_URL = `data:image/png;base64,${PNG_1X1}`;

  function readImageTurn(blocks: ContentBlock[]): Message[] {
    return [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.png' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: blocks } as ContentBlock],
      },
    ];
  }

  it('carries a tool-returned image in a user turn after the tool message', () => {
    const out = toOpenAIMessages('', readImageTurn([
      { type: 'text', text: '[Image]' },
      imageBlock(),
    ]));

    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: '[Image]' });
    expect(out[2]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: DATA_URL } }],
    });
  });

  it('drops a corrupt tool-returned image instead of poisoning the request', () => {
    const out = toOpenAIMessages('', readImageTurn([
      imageBlock(),
      imageBlock(TRUNCATED_PNG),
    ]));

    const imageTurn = out.find(
      (m) => Array.isArray(m.content) && m.content[0]?.type === 'image_url',
    );
    expect(imageTurn!.content).toHaveLength(1);
  });

  it('adds no image turn when the tool returned text only', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];

    expect(toOpenAIMessages('', messages)).toHaveLength(2);
  });
});