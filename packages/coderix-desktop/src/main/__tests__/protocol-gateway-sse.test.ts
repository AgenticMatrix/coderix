import { describe, expect, it } from 'vitest';
import { ChatToMessagesSseConverter } from '../protocol-gateway/messages-to-chat.js';

function delta(payload: Record<string, unknown>): string {
  return JSON.stringify({ model: 'test-model', choices: [{ index: 0, delta: payload }] });
}

function collect(converter: ChatToMessagesSseConverter, payloads: string[]) {
  const frames = payloads.flatMap((data) => converter.convertSse(null, data));
  return frames.concat(converter.finishSse());
}

function toolStarts(frames: Array<{ event?: string; data: string }>) {
  return frames
    .filter((f) => f.event === 'content_block_start')
    .map((f) => JSON.parse(f.data).content_block)
    .filter((b) => b.type === 'tool_use');
}

describe('ChatToMessagesSseConverter tool calls', () => {
  it('carries the tool name on content_block_start when it arrives in the opening chunk', () => {
    const converter = new ChatToMessagesSseConverter();
    const frames = collect(converter, [
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }),
    ]);

    expect(toolStarts(frames)).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: {} },
    ]);
  });

  it('holds the start frame until a later chunk supplies the name', () => {
    const converter = new ChatToMessagesSseConverter();
    const frames = collect(converter, [
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { arguments: '{"file' } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: 'Read', arguments: '_path":"a.ts"}' } }] }),
    ]);

    expect(toolStarts(frames)).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
    ]);

    const partial = frames
      .filter((f) => f.event === 'content_block_delta')
      .map((f) => JSON.parse(f.data).delta.partial_json)
      .join('');
    expect(partial).toBe('{"file_path":"a.ts"}');
    expect(partial.slice(0, 6)).toBe('{"file');
  });

  it('still closes a block whose name never arrives', () => {
    const converter = new ChatToMessagesSseConverter();
    const frames = collect(converter, [
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { arguments: '{}' } }] }),
    ]);

    const types = frames.map((f) => f.event);
    expect(types).toContain('content_block_start');
    expect(types).toContain('content_block_stop');
    expect(toolStarts(frames)).toEqual([
      { type: 'tool_use', id: 'call_1', name: '', input: {} },
    ]);
  });
});