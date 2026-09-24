import React, { useEffect, useMemo, useRef, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { Box, Text, Static, ScrollBox, renderSync } from '@coderix/tui';
import type { ScrollBoxHandle } from '@coderix/tui';
import {
  emulate,
  countRows,
} from '@coderix/tui/testing';
import { splitTranscript, shouldFlush, advanceEpoch, initialEpoch } from '../transcript-commit.js';
import type { Message } from '../../../types.js';

/**
 * The reported symptom is a tool HEADER printed twice on adjacent rows, with the
 * tool's RESULT printed only once beneath the second copy:
 *
 *     ● Bash(List claude-code-best directory and parent,
 *     ● Bash(List claude-code-best directory and parent,
 *         NOT FOUND at ../claude-code-best
 *
 * A duplicated block cannot produce that. `SET_TOOL_USE_RESULT` attaches the
 * result to EVERY block with a matching `toolId`, so two blocks would carry two
 * results. One header without a result and one with is the signature of the same
 * message rendered at two different POINTS IN TIME — once while the tool was
 * still executing, once after it settled.
 *
 * Which is exactly what committing to `<Static>` too early would do. A message
 * holding an `executing` tool is not settled, so `splitTranscript` withholds it;
 * but if anything commits it anyway, `<Static>` prints it permanently in its
 * executing form, and the corrected copy is then drawn in the live region below.
 * Scrollback cannot retract rows, so both stay on screen.
 *
 * These tests pin the boundary rule that prevents it.
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

/** A message carrying a single bash tool_use, in the given state. */
function toolMessage(
  label: string,
  state: 'executing' | 'done',
  id = nextId++,
): Message {
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
        ...(state === 'done' ? { result: { content: `result-${id}`, isError: false } } : {}),
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

/**
 * The transcript shell reduced to the parts that decide WHAT goes where: the
 * commit boundary, `<Static>`, and a flex-sized live region. The message
 * renderer prints the tool's header and, once it has one, its result — the two
 * rows whose duplication is being tested.
 */
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

describe('a tool that finishes after its message was committable', () => {
  it('never commits a message whose tool is still executing', () => {
    const history = [textMessage('old-1'), textMessage('old-2')];
    const running = [...history, toolMessage('List dirs', 'executing')];

    // The boundary must stop AT the executing tool, so the message holding it
    // can still be redrawn when its result lands.
    expect(splitTranscript(running).committed.length).toBe(2);
    expect(splitTranscript(running).live.map((m) => m.id)).toEqual([running[2]!.id]);
  });

  it('keeps the boundary from moving backwards when a tool settles', () => {
    // A settling tool can only ever ADD to what is committable. If it could
    // subtract, a message already printed by <Static> would have to be
    // un-printed — impossible in scrollback, and the source of a stale copy.
    const base = [textMessage('a'), textMessage('b'), textMessage('c')];
    const withRunning = [...base, toolMessage('List dirs', 'executing')];
    const settled = [...base, { ...withRunning[3]! }];
    (settled[3] as unknown as { blocks: Array<{ state: string }> }).blocks[0]!.state = 'done';

    const before = splitTranscript(withRunning).committed.length;
    const after = splitTranscript(settled).committed.length;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('shows the tool header exactly once as the tool goes from executing to done', async () => {
    const stdout = mkStdout();
    // Enough settled history that the live region fills and a flush is due.
    const history = Array.from({ length: 12 }, (_, i) => textMessage(`hist-${i}`));
    const running = [...history, toolMessage('List dirs', 'executing')];

    // `renderSync` is what the real app uses, so the test exercises the same
    // incremental writer — the one that rewrites only changed lines, and hence
    // the one where a stale row can survive.
    const app = renderSync(<Shell messages={running} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    // The tool settles: same message id, now carrying a result.
    const done = [...history, toolMessage('List dirs', 'done', running[12]!.id)];
    app.rerender(<Shell messages={done} />);
    await tick();

    const screen = emulate(stdout.getBuf(), COLS, ROWS);
    app.unmount();

    const header = '* Bash(List dirs';
    const onScreen = countRows(screen, header);
    const inScrollback = screen.scrollback.filter((r) => r.trim() === header).length;

    // One copy total — on screen or in scrollback, never both.
    expect(onScreen + inScrollback).toBe(1);
  });
});
