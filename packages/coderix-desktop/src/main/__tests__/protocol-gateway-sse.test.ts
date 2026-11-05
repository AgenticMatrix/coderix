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

describe('ChatToMessagesSseConverter turn termination', () => {
  /** A terminal chunk that carries finish_reason but no `delta`. */
  function finishChunk(reason: string): string {
    return JSON.stringify({ model: 'test-model', choices: [{ index: 0, finish_reason: reason }] });
  }

  function stopReasonOf(frames: Array<{ event?: string; data: string }>): string | undefined {
    const delta = frames.find((f) => f.event === 'message_delta');
    return delta ? JSON.parse(delta.data).delta.stop_reason : undefined;
  }

  it('keeps a tool_calls finish that arrives on a delta-less terminal chunk', () => {
    const converter = new ChatToMessagesSseConverter();
    const frames = collect(converter, [
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }),
      finishChunk('tool_calls'),
    ]);

    // Without the reason the CLI saw `end_turn` and never ran the tool.
    expect(stopReasonOf(frames)).toBe('tool_use');
  });

  it('does not fabricate a completion when the stream is cut mid-answer', () => {
    const converter = new ChatToMessagesSseConverter();
    // Text starts flowing, then the socket closes with no finish_reason.
    const frames = collect(converter, [delta({ content: 'I will now edit the file' })]);

    expect(stopReasonOf(frames)).toBeUndefined();
    const errors = frames.filter((f) => f.event === 'error');
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!.data).type).toBe('error');
    // The partial text still closes cleanly so it renders instead of vanishing.
    expect(frames.map((f) => f.event)).toContain('content_block_stop');
    expect(frames.map((f) => f.event)).not.toContain('message_stop');
  });

  it('reports an upstream that closed before sending anything', () => {
    const converter = new ChatToMessagesSseConverter();
    const frames = converter.finishSse();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('error');
  });

  it('still completes normally when the upstream reports a real finish', () => {
    const converter = new ChatToMessagesSseConverter();
    const frames = collect(converter, [
      delta({ content: 'done' }),
      finishChunk('stop'),
    ]);

    expect(stopReasonOf(frames)).toBe('end_turn');
    expect(frames.filter((f) => f.event === 'error')).toHaveLength(0);
  });
});