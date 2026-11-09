import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, Box, Text } from 'ink';
import { PassThrough } from 'node:stream';
import ScrollBox from '../scroll-viewport.js';
import type { ScrollBoxHandle } from '../scroll-viewport.js';
import { emulate } from '../testing/term-emulator.js';

const COLS = 80;
const ROWS = 24;

type FakeStdout = {
  isTTY: boolean; columns: number; rows: number;
  on: (event: string, handler: (chunk: Buffer) => void) => void;
  getBuf: () => string;
};

function mkStdout(): FakeStdout {
  const s = new PassThrough() as unknown as FakeStdout;
  s.isTTY = true; s.columns = COLS; s.rows = ROWS;
  let buf = '';
  s.on('data', (c: Buffer) => { buf += c.toString(); });
  s.getBuf = () => buf;
  return s;
}

const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms));

function Shell({ lines, handleRef }: { lines: number; handleRef: React.Ref<ScrollBoxHandle> }) {
  return (
    <Box flexDirection="column" maxHeight={ROWS - 1}>
      <Box height={1} flexShrink={0} />
      <ScrollBox ref={handleRef} flexShrink={1} minHeight={0} stickyScroll paddingX={1}>
        {Array.from({ length: lines }, (_, i) => (
          <Text key={i}>row-{i}</Text>
        ))}
      </ScrollBox>
      <Box flexShrink={0} flexDirection="column">
        <Text>footer-1</Text>
        <Text>footer-2</Text>
        <Text>footer-3</Text>
        <Text>footer-4</Text>
        <Text>footer-5</Text>
      </Box>
    </Box>
  );
}

/**
 * A scroll offset must never survive content that no longer overflows.
 *
 * The offset is applied as `marginTop = -scrollTop` on the inner wrapper. In
 * flex mode the viewport's height comes from its children, and a negative
 * margin shrinks the box that Yoga measures, so a viewport is only ever
 * `content - scrollTop` tall. `maxScroll` is then `content - viewport`, i.e.
 * `scrollTop` itself, and sticky scroll keeps the two equal: EVERY offset is a
 * fixed point. A transient offset — sticky scroll on a tall transcript, or a
 * briefly stale viewport measurement — therefore pins itself permanently, and
 * the top `scrollTop` rows stay clipped even after the content shrinks to fit.
 *
 * On screen this reads as a dropped message: a settled tool block whose header
 * was scrolled out of the live region and never committed anywhere (the live
 * region is the only path into the terminal besides `<Static>`), while the rows
 * below it remain.
 *
 * The fix cancels the shift with `paddingBottom = scrollTop`, so the wrapper's
 * margin box keeps the content's natural height and an unconstrained viewport
 * always reports "everything fits".
 */
describe('ScrollBox releases a stale scroll offset when the content shrinks', () => {
  it('returns to the top and shows every row once the content fits', async () => {
    const stdout = mkStdout();
    const ref = { current: null as ScrollBoxHandle | null };

    // Start with more rows than the region can hold so sticky scroll pins the
    // view to the bottom and scrollTop becomes non-zero.
    const app = render(<Shell lines={40} handleRef={ref} />, {
      stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
    });
    await tick(120);
    expect(ref.current!.getScrollTop(), 'scrolled to the bottom while content overflows').toBeGreaterThan(0);

    // Now shrink the content so it fits comfortably. Nothing should remain
    // clipped: a viewport sized by `content - scrollTop` makes
    // `maxScroll === scrollTop` a stable fixed point, so the old offset sticks
    // forever and the top rows are lost.
    app.rerender(<Shell lines={3} handleRef={ref} />);
    await tick(180);

    const scrollTop = ref.current!.getScrollTop();
    const screen = emulate(stdout.getBuf(), COLS, ROWS);
    app.unmount();

    expect(scrollTop, 'no stale offset once everything fits').toBe(0);
    const rows = [...screen.scrollback, ...screen.rows].map((r) => r.trim());
    for (const i of [0, 1, 2]) {
      expect(rows.some((r) => r === `row-${i}`), `row-${i} must be visible`).toBe(true);
    }
  });
});