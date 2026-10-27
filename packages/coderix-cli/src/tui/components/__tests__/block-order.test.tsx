import React from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { Box, renderSync } from '@coderix/tui';
import { emulate } from '@coderix/tui/testing';

import { settledToolsFirst } from '../blockOrder.js';
import { MessageBubble } from '../MessageBubble.js';
import type { ContentBlock, Message, TextBlock, ToolUseBlock } from '../../../types.js';

const COLS = 100;
const ROWS = 24;

function mkStdout() {
  const s = new PassThrough() as any;
  s.isTTY = true;
  s.columns = COLS;
  s.rows = ROWS;
  let buf = '';
  s.on('data', (c: Buffer) => {
    buf += c.toString();
  });
  s.getBuf = () => buf;
  return s;
}

const tick = () => new Promise((r) => setTimeout(r, 120));

function tool(id: string, state: ToolUseBlock['state'], description = id): ToolUseBlock {
  return {
    type: 'tool_use',
    toolName: 'Agent',
    toolId: id,
    input: { agent_type: 'explore', description, prompt: `${description} prompt` },
    state,
  };
}

function text(content: string): TextBlock {
  return { type: 'text', content };
}

const ids = (blocks: readonly ContentBlock[]) =>
  blocks.map((b) => (b.type === 'tool_use' ? b.toolId : b.type));

describe('settledToolsFirst', () => {
  it('moves finished tools above running ones, despite call order', () => {
    const blocks: ContentBlock[] = [
      tool('a', 'executing'),
      tool('b', 'done'),
      tool('c', 'executing'),
    ];
    expect(ids(settledToolsFirst(blocks))).toEqual(['b', 'a', 'c']);
  });

  it('keeps the relative order inside each group', () => {
    const blocks: ContentBlock[] = [
      tool('a', 'executing'),
      tool('b', 'done'),
      tool('c', 'pending'),
      tool('d', 'error'),
    ];
    expect(ids(settledToolsFirst(blocks))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('leaves non-tool blocks where they are', () => {
    const blocks: ContentBlock[] = [
      text('intro'),
      tool('a', 'executing'),
      text('middle'),
      tool('b', 'done'),
    ];
    const out = settledToolsFirst(blocks);
    expect(ids(out)).toEqual(['text', 'b', 'text', 'a']);
    expect((out[0] as TextBlock).content).toBe('intro');
    expect((out[2] as TextBlock).content).toBe('middle');
  });

  it('is a no-op when everything has settled', () => {
    const blocks: ContentBlock[] = [tool('a', 'done'), tool('b', 'error')];
    expect(ids(settledToolsFirst(blocks))).toEqual(['a', 'b']);
  });

  it('preserves block identity so React keys survive the move', () => {
    const running = tool('a', 'executing');
    const done = tool('b', 'done');
    const out = settledToolsFirst([running, done]);
    expect(out[0]).toBe(done);
    expect(out[1]).toBe(running);
  });
});

describe('MessageBubble block order', () => {
  const messageWith = (states: Array<ToolUseBlock['state']>) =>
    ({
      id: 1,
      role: 'assistant',
      content: '',
      timestamp: 0,
      blocks: [
        tool('t1', states[0]!, 'needs-core-engine'),
        tool('t2', states[1]!, 'desktop-survey'),
        tool('t3', states[2]!, 'cli-survey'),
      ],
    }) as unknown as Message;

  it('hoists a finished sub-agent while the others run, then returns to call order', async () => {
    const stdout = mkStdout();
    const app = renderSync(
      <Box flexDirection="column">
        <MessageBubble
          message={messageWith(['executing', 'done', 'executing'])}
          contentExpanded={false}
          hideThinking
          streaming
        />
      </Box>,
      { stdout: stdout as never, patchConsole: false },
    );
    await tick();

    const running = [...emulate(stdout.getBuf(), COLS, ROWS).rows];
    const at = (rows: string[], needle: string) => rows.findIndex((r) => r.includes(needle));
    expect(at(running, 'desktop-survey')).toBeGreaterThanOrEqual(0);
    expect(at(running, 'desktop-survey')).toBeLessThan(at(running, 'needs-core-engine'));
    expect(at(running, 'needs-core-engine')).toBeLessThan(at(running, 'cli-survey'));

    // Everything settled: the hoist is over, call order is restored.
    app.rerender(
      <Box flexDirection="column">
        <MessageBubble
          message={messageWith(['done', 'done', 'done'])}
          contentExpanded={false}
          hideThinking
          streaming={false}
        />
      </Box>,
    );
    await tick();
    app.unmount();
    await tick();

    const screen = emulate(stdout.getBuf(), COLS, ROWS);
    const settled = [...screen.rows, ...screen.scrollback];
    expect(at(settled, 'needs-core-engine')).toBeGreaterThanOrEqual(0);
    expect(at(settled, 'needs-core-engine')).toBeLessThan(at(settled, 'desktop-survey'));
    expect(at(settled, 'desktop-survey')).toBeLessThan(at(settled, 'cli-survey'));
  });
});
