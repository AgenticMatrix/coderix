/**
 * Unit tests for the anthropic↔openai protocol-gateway converter
 * (messages-to-chat), specifically the reasoning_content → thinking
 * translation that lets the claude-code engine surface OpenAI-model
 * reasoning (DeepSeek reasoner / vLLM reasoning models).
 */
import { describe, it, expect } from 'vitest';
import {
  chatResponseToMessages,
  ChatToMessagesSseConverter,
} from '../../packages/coderix-desktop/src/main/protocol-gateway/messages-to-chat';

function feed(
  c: ChatToMessagesSseConverter,
  ...events: Array<[string | null, string]>
): ReturnType<ChatToMessagesSseConverter['convertSse']> {
  const out: ReturnType<ChatToMessagesSseConverter['convertSse']> = [];
  for (const [event, data] of events) out.push(...c.convertSse(event, data));
  return out;
}

describe('messages-to-chat — reasoning_content → thinking', () => {
  it('turns streaming reasoning_content deltas into a thinking block', () => {
    const c = new ChatToMessagesSseConverter();
    const frames = feed(
      c,
      [null, JSON.stringify({ model: 'Atria-Dawn-Preview', choices: [{ index: 0, delta: { reasoning_content: '1. ' } }] })],
      [null, JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'think' } }] })],
    );

    const starts = frames.filter((f) => JSON.parse(f.data).type === 'content_block_start');
    expect(starts).toHaveLength(1);
    expect(JSON.parse(starts[0]!.data).content_block).toEqual({ type: 'thinking', thinking: '' });

    const deltas = frames.filter((f) => JSON.parse(f.data).type === 'content_block_delta');
    expect(deltas.map((f) => JSON.parse(f.data).delta.thinking).join('')).toBe('1. think');
  });

  it('closes the thinking block before opening the text block', () => {
    const c = new ChatToMessagesSseConverter();
    const frames = feed(
      c,
      [null, JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { reasoning_content: 'reasoning' } }] })],
      [null, JSON.stringify({ choices: [{ index: 0, delta: { content: 'answer' } }] })],
    );

    const types = frames.map((f) => JSON.parse(f.data).type);
    expect(types).toEqual([
      'message_start',
      'content_block_start', // thinking
      'content_block_delta', // thinking_delta
      'content_block_stop', // thinking
      'content_block_start', // text
      'content_block_delta', // text_delta
    ]);
  });

  it('finishSse closes a still-open thinking block', () => {
    const c = new ChatToMessagesSseConverter();
    feed(c, [null, JSON.stringify({ model: 'm', choices: [{ index: 0, delta: { reasoning_content: 'reasoning only' } }] })]);
    const stops = c.finishSse().filter((f) => JSON.parse(f.data).type === 'content_block_stop');
    expect(stops).toHaveLength(1); // thinking stop only — no text block was opened
  });

  it('maps non-streaming message.reasoning_content to a leading thinking block', () => {
    const body = {
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', reasoning_content: 'I thought about it', content: 'the answer' },
        },
      ],
      model: 'Atria-Dawn-Preview',
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    const out = chatResponseToMessages(body);
    expect(out.content[0]).toEqual({ type: 'thinking', thinking: 'I thought about it' });
    expect(out.content[1]).toEqual({ type: 'text', text: 'the answer' });
  });

  it('omits the thinking block when there is no reasoning_content', () => {
    const body = {
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'plain answer' } }],
      model: 'm',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const out = chatResponseToMessages(body);
    expect(out.content).toEqual([{ type: 'text', text: 'plain answer' }]);
  });
});
