import React from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { renderSync } from '@coderix/tui';
import { emulate } from '@coderix/tui/testing';
import { MessageBubble } from '../MessageBubble.js';
import type { Message } from '../../../types.js';

/**
 * BLOCK SPACING: ONE BLANK LINE, EVERYWHERE, COUNTED ONCE.
 *
 * The rule: blocks (text, tool cards, results, boundaries) are separated
 * by exactly one blank line. The defect that kept reappearing when the
 * gap was two: the blank lines lived on the tool renderer's root
 * `marginBottom`, while `MessageBubble` added a message-level margin on
 * top. Ink/Yoga does not collapse margins across nesting levels, so a
 * tool card ending a message — the normal case, since a tool call ends
 * the turn — rendered 2 + 1 = 3 blank lines before the tool result,
 * while a text block (no margin of its own) got 0 lines to the next
 * block and a result message got 1.
 *
 * The fix keeps ALL vertical spacing at the block level; message-level
 * containers carry none. These tests pin the rule by rendering the real
 * `MessageBubble` and counting blank rows in the emulated screen — what
 * the user sees, not what the margin props claim.
 */

const COLS = 80;
const ROWS = 40;
const tick = () => new Promise((r) => setTimeout(r, 250));

type FakeStdout = {
  isTTY: boolean;
  columns: number;
  rows: number;
  on: (event: string, handler: (chunk: Buffer) => void) => void;
  getBuf: () => string;
};

function mkStdout(): FakeStdout {
  const s = new PassThrough() as unknown as FakeStdout;
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

let nextId = 1;

function textMessage(content: string): Message {
  return {
    id: nextId++,
    role: 'assistant',
    content,
    timestamp: 0,
    blocks: [{ type: 'text', content }],
  } as unknown as Message;
}

function bashToolMessage(): Message {
  return {
    id: nextId++,
    role: 'assistant',
    content: '',
    timestamp: 0,
    blocks: [
      {
        type: 'tool_use',
        toolName: 'bash',
        toolId: 'bash-1',
        input: { command: 'ls -la', description: 'list files' },
        state: 'done',
        duration: 120,
      },
    ],
  } as unknown as Message;
}

function bashResultMessage(content: string): Message {
  return {
    id: nextId++,
    role: 'user',
    content: '',
    timestamp: 0,
    blocks: [
      {
        type: 'tool_result',
        toolId: 'bash-1',
        toolName: 'bash',
        content,
        isError: false,
        duration: 120,
      },
    ],
  } as unknown as Message;
}

/** Count consecutive blank rows immediately before `idx` (exclusive). */
function gapBefore(rows: string[], idx: number): number {
  let n = 0;
  for (let i = idx - 1; i >= 0 && rows[i]!.trim() === ''; i--) n += 1;
  return n;
}

function firstRowWith(rows: string[], needle: string): number {
  const idx = rows.findIndex((r) => r.includes(needle));
  expect(idx, `row containing "${needle}" should exist`).toBeGreaterThan(-1);
  return idx;
}

async function renderRows(messages: Message[]): Promise<string[]> {
  const stdout = mkStdout();
  const app = renderSync(
    <>
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
    </>,
    { stdout: stdout as never, patchConsole: false },
  );
  await tick();
  const out = stdout.getBuf();
  app.unmount();
  const screen = emulate(out, COLS, ROWS);
  return [...screen.scrollback, ...screen.rows];
}

describe('spacing between blocks', () => {
  it('is exactly one blank line between text, tool card and tool result', async () => {
    const rows = await renderRows([
      textMessage('First text block.'),
      bashToolMessage(),
      bashResultMessage('file a\nfile b'),
      textMessage('Second text block.'),
    ]);

    const iText1 = firstRowWith(rows, 'First text block');
    const iTool = firstRowWith(rows, 'Bash(');
    const iResultBorder = rows.findIndex((r) => r.trimStart().startsWith('┌'));
    expect(iResultBorder, 'result card top border should exist').toBeGreaterThan(-1);
    const iText2 = firstRowWith(rows, 'Second text block');

    // text → tool card (same assistant message)
    expect(gapBefore(rows, iTool)).toBe(1);
    // tool card → tool result (across the message boundary — the reported 3-line bug)
    expect(gapBefore(rows, iResultBorder)).toBe(1);
    // tool result → next text block
    expect(gapBefore(rows, iText2)).toBe(1);
    // markers stay in order
    expect(iText1).toBeLessThan(iTool);
    expect(iTool).toBeLessThan(iResultBorder);
    expect(iResultBorder).toBeLessThan(iText2);
  });

  it('is exactly one blank line between consecutive tool cards', async () => {
    const rows = await renderRows([
      {
        id: nextId++,
        role: 'assistant',
        content: '',
        timestamp: 0,
        blocks: [
          {
            type: 'tool_use',
            toolName: 'bash',
            toolId: 'a',
            input: { command: 'echo one' },
            state: 'done',
            duration: 10,
          },
          {
            type: 'tool_use',
            toolName: 'bash',
            toolId: 'b',
            input: { command: 'echo two' },
            state: 'done',
            duration: 10,
          },
        ],
      } as unknown as Message,
    ]);

    const iFirst = firstRowWith(rows, 'echo one');
    const iSecond = firstRowWith(rows, 'echo two');
    expect(iFirst).toBeLessThan(iSecond);
    expect(gapBefore(rows, iSecond)).toBe(1);
  });

  it('is exactly one blank line between consecutive tool results in one message', async () => {
    const rows = await renderRows([
      {
        id: nextId++,
        role: 'user',
        content: '',
        timestamp: 0,
        blocks: [
          {
            type: 'tool_result',
            toolId: 'a',
            toolName: 'bash',
            content: 'out-one',
            isError: false,
            duration: 10,
          },
          {
            type: 'tool_result',
            toolId: 'b',
            toolName: 'bash',
            content: 'out-two',
            isError: false,
            duration: 10,
          },
        ],
      } as unknown as Message,
    ]);

    const iFirst = firstRowWith(rows, 'out-one');
    // 'out-two' sits inside the second card; the gap is between the first
    // card's bottom border and the second card's top border.
    const iSecondBorder = rows.findIndex(
      (r, i) => i > iFirst && r.trimStart().startsWith('┌'),
    );
    expect(iSecondBorder, 'second result card border should exist').toBeGreaterThan(-1);
    expect(gapBefore(rows, iSecondBorder)).toBe(1);
  });

  it('indents the tool result card by the icon column once, not twice', async () => {
    const rows = await renderRows([bashToolMessage(), bashResultMessage('file a')]);
    const iResultBorder = rows.findIndex((r) => r.trimStart().startsWith('┌'));
    expect(iResultBorder).toBeGreaterThan(-1);
    // Wrapper contributes the 2-space icon column; the block-level wrapper must
    // not add a second one (the pre-fix double wrap indented by 4).
    expect(rows[iResultBorder]!.slice(0, 3)).toBe('  ┌');
  });
});
