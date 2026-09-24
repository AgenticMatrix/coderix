import React, { useEffect, useMemo, useRef, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { Box, Text, Static, ScrollBox, renderSync } from '@coderix/tui';
import type { ScrollBoxHandle } from '@coderix/tui';
import { emulate } from '@coderix/tui/testing';
import { splitTranscript, shouldFlush, advanceEpoch, initialEpoch } from '../transcript-commit.js';
import type { Message } from '../../../types.js';

/**
 * A flush is the one moment the transcript is written in two pieces: ink clears
 * the interactive region, emits the newly committed rows, then repaints the live
 * frame beneath them. Every row must survive that hand-off exactly once.
 *
 * Two ways it can go wrong, and both look like the reported duplication:
 *
 *   - the clear is too SHORT, so a row of the old frame is left above the static
 *     output and the newly committed copy is printed below it; or
 *   - the clear is too LONG, or the split is misaligned, and a row is lost.
 *
 * `log.clear()` is sized from the PREVIOUS frame's line count, so both hinge on
 * the frame height being correct on the frame before the flush. That is what
 * makes this the natural place to catch a height that was computed from a stale
 * measurement.
 *
 * The check is a census: every message must appear exactly once across
 * scrollback and screen combined — never zero times, never twice.
 */

const COLS = 80;
const ROWS = 24;

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

const tick = () => new Promise((r) => setTimeout(r, 90));

let nextId = 1;

function toolMessage(label: string, state: 'executing' | 'done', id = nextId++): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    timestamp: 0,
    blocks: [
      {
        type: 'tool_use',
        toolId: `t${id}`,
        toolName: 'bash',
        input: { description: label },
        state,
        ...(state === 'done' ? { result: { content: `res(${label})`, isError: false } } : {}),
      },
    ],
  } as unknown as Message;
}

function textMessage(body: string, id = nextId++): Message {
  return {
    id,
    role: 'assistant',
    content: body,
    timestamp: 0,
    blocks: [{ type: 'text', content: body }],
  } as unknown as Message;
}

function Shell({ messages }: { messages: readonly Message[] }) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const [committedCount, setCommittedCount] = useState(0);

  const committableCount = useMemo(
    () => splitTranscript(messages).committed.length,
    [messages],
  );

  useEffect(() => {
    const liveRegionRows = scrollRef.current?.getViewportHeight() ?? 0;
    if (liveRegionRows <= 0) return;
    const next = shouldFlush({
      committableCount,
      liveContentRows: scrollRef.current?.getContentHeight() ?? 0,
      liveRegionRows,
      alreadyCommitted: committedCount,
    });
    if (next > 0) setCommittedCount(next);
  }, [committableCount, committedCount, messages]);

  const effectiveCommitted = Math.min(committedCount, committableCount);
  const committed = messages.slice(0, effectiveCommitted);
  const live = messages.slice(effectiveCommitted);

  const epochRef = useRef(initialEpoch());
  epochRef.current = advanceEpoch(epochRef.current, {
    renderRevision: 0,
    committedCount: effectiveCommitted,
  });

  const renderMessage = (m: Message) => {
    const block = m.blocks[0]!;
    if (block.type !== 'tool_use') {
      return <Text key={m.id}>{m.content}</Text>;
    }
    const b = block as unknown as {
      input: { description: string };
      result?: { content: string };
    };
    return (
      <Box key={m.id} flexDirection="column">
        <Text>{`* Bash(${b.input.description}`}</Text>
        {b.result && <Text>{`    ${b.result.content}`}</Text>}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" height={ROWS - 1}>
      {/* A sibling spacer, never the root's `paddingTop` — padding above the
          static region drops its last rows. See `static-region.test.tsx`. */}
      <Box height={1} flexShrink={0} />
      <Static key={epochRef.current.token} items={[...committed]}>
        {(m) => <Box key={m.id}>{renderMessage(m)}</Box>}
      </Static>
      <ScrollBox ref={scrollRef} flexGrow={1} flexShrink={1} minHeight={0} stickyScroll>
        {live.map(renderMessage)}
      </ScrollBox>
      <Box flexShrink={0}>
        <Text>status-bar</Text>
      </Box>
    </Box>
  );
}

/** Every row the terminal holds, scrollback first, in order. */
function allRows(out: string): string[] {
  const screen = emulate(out, COLS, ROWS);
  return [...screen.scrollback, ...screen.rows].map((r) => r.trim());
}

function census(out: string, needle: string): number {
  return allRows(out).filter((r) => r === needle).length;
}

describe('the frame where committed rows are handed to scrollback', () => {
  it('loses no history row and duplicates none, across a flush', async () => {
    const stdout = mkStdout();
    const history = Array.from({ length: 12 }, (_, i) => textMessage(`hist-${i}`));
    const running = [...history, toolMessage('List dirs', 'executing')];

    const app = renderSync(<Shell messages={running} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    const settled = [...history, toolMessage('List dirs', 'done', running[12]!.id)];
    app.rerender(<Shell messages={settled} />);
    await tick();

    const out = stdout.getBuf();
    app.unmount();

    // Each of the twelve history messages must be present exactly once. A
    // stranded row makes one of these 2; a clear that overshot makes it 0.
    const counts = history.map((m) => census(out, m.content));
    expect(counts).toEqual(history.map(() => 1));
  });

  it('shows a settling tool exactly once, header and result together', async () => {
    const stdout = mkStdout();
    const history = Array.from({ length: 12 }, (_, i) => textMessage(`h-${i}`));
    const running = [...history, toolMessage('Search dirs', 'executing')];

    const app = renderSync(<Shell messages={running} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    const settled = [...history, toolMessage('Search dirs', 'done', running[12]!.id)];
    app.rerender(<Shell messages={settled} />);
    await tick();

    const out = stdout.getBuf();
    app.unmount();

    expect(census(out, '* Bash(Search dirs')).toBe(1);
    expect(census(out, 'res(Search dirs)')).toBe(1);
  });

  it('survives several tools settling one after another', async () => {
    const stdout = mkStdout();
    const history = Array.from({ length: 10 }, (_, i) => textMessage(`x-${i}`));
    const labels = ['one', 'two', 'three', 'four'];
    const tools = labels.map((l) => toolMessage(l, 'executing'));

    let messages: Message[] = [...history, ...tools];
    const app = renderSync(<Shell messages={messages} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    // Settle them in order, as concurrent tools return one result at a time.
    for (let i = 0; i < labels.length; i++) {
      messages = [
        ...history,
        ...labels.map((l, j) =>
          j <= i ? toolMessage(l, 'done', tools[j]!.id) : toolMessage(l, 'executing', tools[j]!.id),
        ),
      ];
      app.rerender(<Shell messages={messages} />);
      await tick();
    }

    const out = stdout.getBuf();
    app.unmount();

    for (const l of labels) {
      expect(census(out, `* Bash(${l}`)).toBe(1);
      expect(census(out, `res(${l})`)).toBe(1);
    }
    for (const m of history) {
      expect(census(out, m.content)).toBe(1);
    }
  });
});
