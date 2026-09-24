import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, Box, Text } from 'ink';
import { PassThrough } from 'node:stream';
import ScrollBox from '../scroll-viewport.js';
import type { ScrollBoxHandle } from '../scroll-viewport.js';
import { emulate } from '../testing/term-emulator.js';

/**
 * In flex mode the viewport height is not a prop — it has to be read back off
 * the outer box with `useBoxMetrics`, which reports from an effect and is
 * therefore 0 on the first frame.
 *
 * That zero is not harmless. The scroll arithmetic derives
 * `maxScroll = contentHeight - viewportHeight`, so a viewport of 0 makes
 * `maxScroll` the FULL content height; sticky scroll then pins `scrollTop`
 * there, and `marginTop={-scrollTop}` lifts every row clean out of the
 * clipping window. The first frame renders blank.
 *
 * These tests fix the content that must be on screen, so a viewport that has
 * not been measured yet cannot be mistaken for a viewport of height zero.
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

function Shell({
  lines,
  handleRef,
}: {
  lines: number;
  handleRef?: React.Ref<ScrollBoxHandle>;
}) {
  return (
    <Box flexDirection="column" height={ROWS - 1}>
      <ScrollBox ref={handleRef} flexGrow={1} flexShrink={1} minHeight={0} stickyScroll>
        {Array.from({ length: lines }, (_, i) => (
          <Text key={i}>row-{i}</Text>
        ))}
      </ScrollBox>
      <Box flexShrink={0}>
        <Text>status-bar</Text>
      </Box>
    </Box>
  );
}

describe('a flex-sized viewport on its very first frame', () => {
  it('shows content that fits, rather than scrolling it out of view', async () => {
    const stdout = mkStdout();
    const app = render(<Shell lines={3} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();
    const screen = emulate(stdout.getBuf(), COLS, ROWS);
    app.unmount();

    // Content far shorter than the viewport cannot be scrolled at all, so all
    // three rows must be present regardless of when the height was measured.
    const visible = screen.rows.map((r) => r.trim());
    expect(visible).toContain('row-0');
    expect(visible).toContain('row-1');
    expect(visible).toContain('row-2');
  });

  it('reports the granted height, never zero, once laid out', async () => {
    const stdout = mkStdout();
    const handle = React.createRef<ScrollBoxHandle>();
    const app = render(<Shell lines={3} handleRef={handle} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();
    const viewport = handle.current?.getViewportHeight() ?? -1;
    app.unmount();

    // The root is 23 rows and the status bar claims 1, so the viewport is 22.
    expect(viewport).toBe(ROWS - 2);
  });

  it('keeps the newest row visible when the content overflows', async () => {
    const stdout = mkStdout();
    const app = render(<Shell lines={200} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();
    const screen = emulate(stdout.getBuf(), COLS, ROWS);
    app.unmount();

    const visible = screen.rows.map((r) => r.trim());
    expect(visible).toContain('row-199');
    expect(visible.at(-1)).toBe('status-bar');
  });
});
