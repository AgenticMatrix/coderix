import React, { useEffect, useMemo, useRef, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { Box, Text, Static, ScrollBox, renderSync } from '@coderix/tui';
import type { ScrollBoxHandle } from '@coderix/tui';
import { emulate } from '@coderix/tui/testing';
import { splitTranscript, shouldFlush, advanceEpoch, initialEpoch } from '../transcript-commit.js';
import { VirtualMessageList } from '../VirtualMessageList.js';
import type { Message } from '../../../types.js';

const COLS = 80;
const ROWS = 24;

function mkStdout() {
  const s = new PassThrough() as any;
  s.isTTY = true; s.columns = COLS; s.rows = ROWS;
  let buf = '';
  s.on('data', (c: Buffer) => { buf += c.toString(); });
  s.getBuf = () => buf;
  return s;
}
const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
function textMessage(body: string, id = nextId++): Message {
  return { id, role: 'assistant', content: body, timestamp: 0, blocks: [{ type: 'text', content: body }] } as unknown as Message;
}
function toolMessage(label: string, state: 'executing' | 'done', id = nextId++): Message {
  return {
    id, role: 'assistant', content: '', timestamp: 0,
    blocks: [{
      type: 'tool_use', toolId: `t${id}`, toolName: 'bash', input: { description: label }, state,
      ...(state === 'done' ? { result: { content: 'line1\nline2\nline3', isError: false } } : {}),
    }],
  } as unknown as Message;
}

function BlinkingBash({ block }: { block: { input: { description: string }; state: string; result?: { content: string } } }) {
  const isActive = block.state === 'executing';
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setT((x) => x + 1), 100);
    return () => clearInterval(id);
  }, [isActive]);
  const icon = isActive ? (Math.floor(t / 5) % 2 === 0 ? '●' : '○') : '●';
  return (
    <Box flexDirection="column">
      <Text>{`${icon} Bash(${block.input.description}`}</Text>
      {isActive ? <Text>{`    running ${(t * 0.1).toFixed(1)}s`}</Text> : null}
      {!isActive && block.result ? <Text>{`    ${block.result.content.split('\n').join(' / ')}`}</Text> : null}
    </Box>
  );
}

function Shell({ messages }: { messages: readonly Message[] }) {
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const [committedCount, setCommittedCount] = useState(0);
  const committableCount = useMemo(() => splitTranscript(messages).committed.length, [messages]);
  useEffect(() => {
    const h = scrollRef.current?.getViewportHeight() ?? 0;
    if (h <= 0) return;
    const next = shouldFlush({ committableCount, liveContentRows: scrollRef.current?.getContentHeight() ?? 0, liveRegionRows: h, alreadyCommitted: committedCount });
    if (next > 0) setCommittedCount(next);
  }, [committableCount, committedCount, messages]);
  const effectiveCommitted = Math.min(committedCount, committableCount);
  const committed = messages.slice(0, effectiveCommitted);
  const live = messages.slice(effectiveCommitted);
  const epochRef = useRef(initialEpoch());
  epochRef.current = advanceEpoch(epochRef.current, { renderRevision: 0, committedCount: effectiveCommitted });

  const renderMessage = (m: Message, _idx: number) => {
    const b = m.blocks[0]!;
    if (b.type !== 'tool_use') return <Text key={m.id}>{m.content}</Text>;
    return <BlinkingBash key={m.id} block={b as never} />;
  };

  return (
    <Box flexDirection="column" height={ROWS - 1}>
      <Box height={1} flexShrink={0} />
      <Static key={epochRef.current.token} items={[...committed]}>
        {(m) => <Box key={m.id}>{renderMessage(m, 0)}</Box>}
      </Static>
      <ScrollBox ref={scrollRef} flexGrow={1} flexShrink={1} minHeight={0} stickyScroll>
        <VirtualMessageList messages={live} scrollRef={scrollRef} columns={COLS} renderMessage={renderMessage} />
      </ScrollBox>
      <Box flexShrink={0}><Text>status-bar</Text></Box>
    </Box>
  );
}

describe('a blinking bash whose result grows the message (virtualized)', () => {
  it('does not strand the executing copy when the message commits', async () => {
    const stdout = mkStdout();
    const history = Array.from({ length: 12 }, (_, i) => textMessage(`hist-${i}`));
    const running = [...history, toolMessage('List dirs', 'executing')];

    const app = renderSync(<Shell messages={running} />, { stdout: stdout as never, patchConsole: false });
    await tick(250);

    const done = [...history, toolMessage('List dirs', 'done', running[12]!.id)];
    app.rerender(<Shell messages={done} />);
    await tick(300);

    const screen = emulate(stdout.getBuf(), COLS, ROWS);
    app.unmount();

    const everywhere = [...screen.rows, ...screen.scrollback];
    const bashRows = everywhere.filter((r) => r.includes('Bash(List dirs'));

    expect(bashRows.length).toBe(1);
  });
});
