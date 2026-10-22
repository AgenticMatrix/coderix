import React, { useEffect, useMemo, useRef, useState } from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  Box,
  Text,
  Static,
  ScrollBox,
  renderSync,
  useMeasuredBox,
} from '@coderix/tui';
import type { ScrollBoxHandle, DOMElement } from '@coderix/tui';

import { MessageBubble } from '../MessageBubble.js';
import { VirtualMessageList } from '../VirtualMessageList.js';
import { splitTranscript, shouldFlush, advanceEpoch, initialEpoch } from '../transcript-commit.js';
import { convertTranscriptToMessages } from '../../hooks/useChatReducer.js';
import type { Message } from '../../../types.js';

/**
 * Regression: the sub-agent transcript view used to crash the CLI with
 * React #185 (maximum update depth exceeded) shortly after opening it.
 *
 * Two independent defects fed the same loop:
 *  1. `convertTranscriptToMessages` minted `id = Date.now() + i`, so every
 *     transcript poll changed every React key and remounted the whole list.
 *  2. Every row measured itself through ink's `useBoxMetrics`, which enqueues
 *     a setState from `resetAfterCommit`. Hundreds of remounted rows turned
 *     into a synchronous layout/update cascade, and React aborted at 50.
 *
 * This test drives the production conversion + virtual list across a growing
 * transcript and asserts ids (and therefore row identity) are stable.
 */

const COLS = 100;
const ROWS = 30;

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

const tick = () => new Promise((r) => setTimeout(r, 120));

function Shell({ messages, subAgentId }: { messages: readonly Message[]; subAgentId?: string }) {
  const rootRows = ROWS - 1;
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const liveRef = useRef<DOMElement | null>(null);
  const liveMetrics = useMeasuredBox(liveRef);
  const footerRef = useRef<DOMElement | null>(null);
  const footerMetrics = useMeasuredBox(footerRef);

  const committableCount = useMemo(
    () => splitTranscript(messages, { streaming: false }).committed.length,
    [messages],
  );
  const [committedCount, setCommittedCount] = useState(0);

  useEffect(() => {
    const liveRegionRows = rootRows - 1 - footerMetrics.height;
    if (liveRegionRows <= 0) return;
    const next = shouldFlush({
      committableCount,
      liveContentRows: liveMetrics.height,
      liveRegionRows,
      alreadyCommitted: committedCount,
    });
    if (next > 0) setCommittedCount(next);
  }, [committableCount, liveMetrics.height, footerMetrics.height, rootRows, committedCount]);

  const effectiveCommitted = Math.min(committedCount, committableCount);
  const committedMessages = messages.slice(0, effectiveCommitted);
  const liveMessages = messages.slice(effectiveCommitted);

  const epochRef = useRef(initialEpoch());
  epochRef.current = advanceEpoch(epochRef.current, {
    renderRevision: 0,
    committedCount: effectiveCommitted,
    subAgentId,
  });

  const renderMessage = (msg: Message) => <MessageBubble key={msg.id} message={msg} theme="dark" hideThinking />;

  return (
    <Box flexDirection="column" maxHeight={rootRows}>
      <Box height={1} flexShrink={0} />
      <Static key={epochRef.current.token} items={committedMessages}>
        {(msg: Message) => (
          <Box key={msg.id} flexDirection="column" paddingX={1}>
            {renderMessage(msg)}
          </Box>
        )}
      </Static>
      <ScrollBox ref={scrollRef} flexShrink={1} minHeight={0} stickyScroll paddingX={1} contentRef={liveRef}>
        {liveMessages.length > 0 && (
          <VirtualMessageList
            messages={liveMessages}
            scrollRef={scrollRef}
            columns={COLS}
            renderMessage={renderMessage}
          />
        )}
      </ScrollBox>
      <Box ref={footerRef} flexDirection="column" flexShrink={0}>
        <Text>────────────────────────</Text>
        <Text>❯ </Text>
        <Text>model · auto · ctx</Text>
      </Box>
    </Box>
  );
}

function rawTranscript(count: number) {
  const out: Array<{ role: string; content: unknown; timestamp: number }> = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    out.push({
      role,
      content: `${role} ${i}: ` + 'lorem ipsum dolor sit amet\n'.repeat(3),
      timestamp: 1_700_000_000_000 + i,
    });
  }
  return out;
}

describe('sub-agent transcript reload layout', () => {
  it('keeps message ids stable across polls', () => {
    const first = convertTranscriptToMessages(rawTranscript(40));
    const second = convertTranscriptToMessages(rawTranscript(41));

    expect(first.map((m) => m.id)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    // Existing rows keep their identity; only the new one is appended.
    expect(second.slice(0, 40).map((m) => m.id)).toEqual(first.map((m) => m.id));
    expect(second.at(-1)?.id).toBe(41);
  });

  it('survives a running transcript that grows with new polls', async () => {
    const stdout = mkStdout();
    const app = renderSync(<Shell messages={[]} subAgentId="sub-a" />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    for (let n = 1; n <= 60; n++) {
      app.rerender(
        <Shell messages={convertTranscriptToMessages(rawTranscript(n))} subAgentId="sub-a" />,
      );
      await tick();
    }

    expect(stdout.getBuf().length).toBeGreaterThan(0);
    app.unmount();
  });
});
