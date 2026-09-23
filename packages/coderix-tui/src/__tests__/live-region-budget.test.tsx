import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { render, Box, Text, useBoxMetrics } from 'ink';
import type { DOMElement } from 'ink';
import { EventEmitter } from 'node:events';

import { Static } from '../static-region.js';
import ScrollBox from '../scroll-viewport.js';

/**
 * The shell around the transcript rests on two independent guards. They are
 * easy to mistake for one, because both are about height and both were added
 * for the same bug — but each fails differently, and each is verified here
 * against a separate mutation.
 *
 *   1. THE ROOT'S FIXED HEIGHT keeps scrollback alive. Ink erases it
 *      (`ESC[3J`) for any frame that fills the viewport, so the root claims one
 *      row fewer than the terminal, which puts every clearing branch out of
 *      reach. Let the root size itself to its content and the erases come back.
 *
 *   2. THE MEASURED FOOTER BUDGET keeps the newest output on screen. The live
 *      region is clipped, so its height decides how much of the tail is
 *      visible; oversize it and the bottom — where streaming output lands —
 *      is laid out past the last row and never reaches the terminal at all.
 *      Scrollback stays intact, so this failure is silent: the transcript is
 *      still scrollable and simply stops showing the newest line.
 *
 * The footer (hints, input, status, team panel) grows and shrinks, and
 * `useBoxMetrics` reports it a layout pass late, so the frame right after it
 * grows is where the budget is tightest.
 *
 * The layout mirrors `App.tsx`. What is pinned is the arithmetic, not the tree.
 */

const ERASE_SCROLLBACK = '[3J';
const LIVE_COUNT = 40;
const NEWEST_LIVE = `live ${LIVE_COUNT - 1}`;

function fakeTty(columns: number, rows: number) {
  const chunks: string[] = [];
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & {
    written: () => string;
  };
  Object.assign(stream, {
    isTTY: true,
    columns,
    rows,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    written: () => chunks.join(''),
  });
  return stream;
}

function fakeStdin() {
  const stream = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stream, {
    isTTY: true,
    setRawMode: () => stream,
    setEncoding: () => stream,
    resume: () => stream,
    pause: () => stream,
    ref: () => {},
    unref: () => {},
    read: () => null,
  });
  return stream;
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

/**
 * Which guard to disable. `none` is the shipping layout; the others reproduce
 * the two ways this shell can be got wrong, so the assertions below can be
 * shown to fail rather than merely to pass.
 */
type Defeat = 'none' | 'unbounded-root' | 'unbounded-live';

/** The app's shell: committed history, a live tail, and a variable footer. */
function Shell({
  rows,
  footerRows,
  defeat,
}: {
  rows: number;
  footerRows: number;
  defeat: Defeat;
}) {
  const footerRef = useRef<DOMElement | null>(null);
  const footerMetrics = useBoxMetrics(footerRef);

  const ROOT_PADDING_TOP = 1;
  const rootRows = Math.max(1, rows - 1);
  const budgeted = footerMetrics.hasMeasured
    ? Math.max(1, rootRows - ROOT_PADDING_TOP - footerMetrics.height)
    : 1;

  const liveRows = defeat === 'unbounded-live' ? LIVE_COUNT : budgeted;
  const rootHeight = defeat === 'unbounded-root' ? undefined : rootRows;

  return (
    <Box flexDirection="column" height={rootHeight} paddingTop={ROOT_PADDING_TOP}>
      <Static items={[0, 1, 2, 3, 4]}>
        {(index) => <Text key={index}>committed {index}</Text>}
      </Static>
      {/* More rows than can ever fit, so clipping is what decides the height. */}
      <ScrollBox height={liveRows} stickyScroll paddingX={1}>
        {Array.from({ length: LIVE_COUNT }, (_, index) => (
          <Text key={index}>live {index}</Text>
        ))}
      </ScrollBox>
      <Box ref={footerRef} flexDirection="column" flexShrink={0}>
        {Array.from({ length: footerRows }, (_, index) => (
          <Text key={index}>footer {index}</Text>
        ))}
      </Box>
    </Box>
  );
}

/**
 * Renders the shell through a sequence of footer heights and reports what the
 * terminal actually received — bytes on the wire, not component state, because
 * both guards are about what the user can see and scroll to.
 */
async function runFooterSequence(
  rows: number,
  footerHeights: readonly number[],
  defeat: Defeat = 'none',
) {
  const stdout = fakeTty(80, rows);
  const instance = render(
    <Shell rows={rows} footerRows={footerHeights[0]!} defeat={defeat} />,
    { stdout, stdin: fakeStdin(), patchConsole: false, exitOnCtrlC: false },
  );

  for (const footerRows of footerHeights) {
    instance.rerender(<Shell rows={rows} footerRows={footerRows} defeat={defeat} />);
    for (let i = 0; i < 4; i += 1) await nextTick();
  }

  instance.unmount();
  await nextTick();

  const output = stdout.written();
  return {
    erases: output.split(ERASE_SCROLLBACK).length - 1,
    /** Did the newest live row ever make it onto the screen? */
    showsNewestLive: output.includes(NEWEST_LIVE),
  };
}

/** The footer heights the app's own chrome moves through as panels come and go. */
const FOOTER_SEQUENCE = [3, 9, 2, 12, 4] as const;

describe('transcript shell height guards', () => {
  it('never erases scrollback, whatever the footer does', async () => {
    // Abrupt footer growth is the risk: measured a pass late, so the frame
    // rendered against a stale (smaller) height is where a budget would blow.
    const { erases } = await runFooterSequence(16, FOOTER_SEQUENCE);

    expect(erases).toBe(0);
  });

  it('erases scrollback once the root is free to grow', async () => {
    // Guard 1, shown failing. Without this, the test above would pass even if
    // the fixed root height were removed.
    const { erases } = await runFooterSequence(16, FOOTER_SEQUENCE, 'unbounded-root');

    expect(erases).toBeGreaterThan(0);
  });

  it('keeps the newest live row on screen as the footer grows', async () => {
    const { showsNewestLive } = await runFooterSequence(16, FOOTER_SEQUENCE);

    expect(showsNewestLive).toBe(true);
  });

  it('pushes the newest live row off screen once the live region ignores the footer', async () => {
    // Guard 2, shown failing — and note it fails SILENTLY: scrollback is
    // untouched, so the only symptom is that streaming output stops appearing.
    const { showsNewestLive, erases } = await runFooterSequence(
      16,
      FOOTER_SEQUENCE,
      'unbounded-live',
    );

    expect(showsNewestLive).toBe(false);
    expect(erases).toBe(0);
  });

  it('holds both guards across terminal sizes', async () => {
    // At rows=10 a 6-row footer leaves almost nothing; the live region has to
    // shrink rather than push either guard over.
    for (const rows of [10, 16, 24, 40]) {
      const { erases, showsNewestLive } = await runFooterSequence(rows, [2, 6, 3]);

      expect(erases, `rows=${rows}`).toBe(0);
      expect(showsNewestLive, `rows=${rows}`).toBe(true);
    }
  });

  it('survives a footer taller than the terminal', async () => {
    // `Math.max(1, ...)` is load-bearing: a zero or negative live height would
    // be a crash or a blank transcript rather than a short one.
    const { erases } = await runFooterSequence(10, [20]);

    expect(erases).toBe(0);
  });
});
