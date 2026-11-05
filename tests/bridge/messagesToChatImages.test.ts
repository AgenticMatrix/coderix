/**
 * Regression tests for images that arrive inside a tool_result.
 *
 * The Read tool returns the raw pixels of an image file as an image block next
 * to an `[Image]` text placeholder. Chat Completions' `role: "tool"` message
 * accepts only a string, so the converter used to drop the image and the model
 * only ever saw the placeholder — it replied that it could not decode the
 * picture while the file itself was fine.
 */
import { describe, it, expect } from 'vitest';
import { messagesRequestToChat } from '../../packages/coderix-desktop/src/main/protocol-gateway/messages-to-chat';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function readImageTurn(data = PNG_1X1) {
  return {
    model: 'deepseek-v4.1-flash-1017',
    max_tokens: 100,
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'images/01.png' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: '[Image]' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
            ],
          },
        ],
      },
    ],
  };
}

function chatMessages(body: unknown): Array<Record<string, any>> {
  return messagesRequestToChat(body as Record<string, unknown>).messages as Array<Record<string, any>>;
}

describe('messages-to-chat — images inside a tool_result', () => {
  it('carries a tool-returned image in a user turn after the tool message', () => {
    const messages = chatMessages(readImageTurn());

    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 't1',
      // The placeholder stays: it keeps the tool_result ↔ tool_call pairing
      // readable in text-only contexts.
      content: '[Image]',
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
      ],
    });
  });

  it('keeps the payload media type on the data URL', () => {
    const body = readImageTurn();
    (body.messages[1]!.content[0] as any).content[1].source.media_type = 'image/webp';

    const images = chatMessages(body).find(
      (m) => Array.isArray(m.content) && m.content[0]?.type === 'image_url',
    );
    expect(images!.content[0].image_url.url).toBe(`data:image/webp;base64,${PNG_1X1}`);
  });

  it('sends every image when one tool_result carries several', () => {
    const body = readImageTurn();
    (body.messages[1]!.content[0] as any).content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 },
    });

    const images = chatMessages(body).find(
      (m) => Array.isArray(m.content) && m.content[0]?.type === 'image_url',
    );
    expect(images!.content).toHaveLength(2);
  });

  it('adds no image turn when the tool returned text only', () => {
    const body = {
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    };

    const messages = chatMessages(body);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' });
  });

  it('skips an image block with no payload instead of emitting an empty URL', () => {
    const body = readImageTurn('');
    const messages = chatMessages(body);
    expect(messages.some((m) => m.role === 'user')).toBe(false);
  });
});