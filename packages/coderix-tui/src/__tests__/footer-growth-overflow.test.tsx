import React, { useRef } from 'react';
import { describe, it, expect } from 'vitest';
import { render, Box, Text, useBoxMetrics } from 'ink';
import { PassThrough } from 'node:stream';
import ScrollBox from '../scroll-viewport.js';
import { emulate, countRows } from '../testing/term-emulator.js';

/**
 * The footer is not a fixed strip. A TaskPanel appears when tools run, a
 * TeamPanel when sub-agents do, a command hint while typing — so its height
 * changes underneath the live transcript, most visibly when several tools start
 * at once.
 *
 * Sizing the live half by MEASURING that footer cannot work, because
 * `useBoxMetrics` reports from an effect: the value read during render is the
 * previous layout's. On the frame where the footer grows, the live half is
 * still sized against the old, shorter footer, and the two overrun their
 * parent.
 *
 * What makes that overrun hard to spot is that it does NOT trip ink's clearing
 * path — zero `ESC[3J`, asserted below. Ink emits the too-tall frame as-is, and
 * the effect that finally applies the new measurement emits a SECOND complete
 * frame beneath it. Both carry a footer, which is what put two status bars on
 * screen showing different values: two frames, not one frame drawn twice.
 */

const COLS = 80;
const ROWS = 24;
const ROOT_ROWS = ROWS - 1;
const PAD = 1;

type FakeStdout = {
  isTTY: boolean;
  columns: number;
  rows: number;
  on: (event: string, handler: (chunk: Buffer) => void) => void;
  getBuf: () => string;
  reset: () => void;
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
  s.reset = () => {
    buf = '';
  };
  return s;
}

const strip = (s: string) => s.replace(/\[[0-9;?]*[A-Za-z]/g, '');
const tick = () => new Promise((r) => setTimeout(r, 90));

/**
 * How many times a row is actually VISIBLE, by replaying the escapes against a
 * screen model rather than counting occurrences in the byte stream.
 *
 * The distinction is the whole point: ink repaints in place, so a row that
 * appears twice in the stream is usually one row overwritten once. Only the
 * screen state says whether the user sees one footer or two.
 *
 * The WHOLE stream has to be replayed, never a suffix of it. A frame's escapes
 * are relative — `cursor up N`, then overwrite — so they only land correctly on
 * the screen its predecessor left behind. Replaying a delta against a blank
 * screen silently mis-positions every row in it.
 */
function visibleCopies(out: string, row: string): number {
  return countRows(emulate(out, COLS, ROWS), row);
}

/**
 * How many complete frames were WRITTEN, counted in the byte stream.
 *
 * Distinct from `visibleCopies`, and the two must not be confused: ink repaints
 * in place, so two written frames usually mean one frame overwritten once, not
 * two frames on screen. This measures output volume and flicker; only
 * `visibleCopies` measures what the user ends up looking at.
 */
function writtenFrames(out: string, lastFooterRow: string): number {
  return strip(out)
    .split('\n')
    .filter((l) => l.trim() === lastFooterRow).length;
}

const eraseCount = (out: string) => (out.match(/\[3J/g) ?? []).length;

function Footer({ lines }: { lines: number }) {
  return (
    <>
      {Array.from({ length: lines }, (_, i) => (
        <Text key={i}>footer-{i}</Text>
      ))}
    </>
  );
}

/** How the live half used to be sized: from a measured footer height. */
function MeasuredShell({ footerLines, liveLines }: { footerLines: number; liveLines: number }) {
  const footerRef = useRef(null);
  const footer = useBoxMetrics(footerRef);
  const liveRows = footer.hasMeasured ? Math.max(1, ROOT_ROWS - PAD - footer.height) : 1;
  return (
    <Box flexDirection="column" height={ROOT_ROWS} paddingTop={PAD}>
      <ScrollBox height={liveRows} stickyScroll shrinkToContent>
        {Array.from({ length: liveLines }, (_, i) => (
          <Text key={i}>live-{i}</Text>
        ))}
      </ScrollBox>
      <Box ref={footerRef} flexDirection="column" flexShrink={0}>
        <Footer lines={footerLines} />
      </Box>
    </Box>
  );
}

/** How it is sized now: Yoga divides the fixed root in a single pass. */
function FlexShell({ footerLines, liveLines }: { footerLines: number; liveLines: number }) {
  return (
    <Box flexDirection="column" height={ROOT_ROWS} paddingTop={PAD}>
      <ScrollBox flexGrow={1} flexShrink={1} minHeight={0} stickyScroll>
        {Array.from({ length: liveLines }, (_, i) => (
          <Text key={i}>live-{i}</Text>
        ))}
      </ScrollBox>
      <Box flexDirection="column" flexShrink={0}>
        <Footer lines={footerLines} />
      </Box>
    </Box>
  );
}

describe('a footer that grows while concurrent tools run', () => {
  it('renders a second full frame when the live half is sized from a measurement', async () => {
    const stdout = mkStdout();
    const app = render(<MeasuredShell footerLines={3} liveLines={30} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();
    stdout.reset();

    app.rerender(<MeasuredShell footerLines={11} liveLines={30} />);
    await tick();
    const out = stdout.getBuf();
    app.unmount();

    // One logical update, but two complete frames go down the wire: the first
    // sized against the stale footer height, the second after the effect
    // applies the new measurement. Ink repaints rather than appends, so this
    // is flicker and wasted output rather than a permanently stale row — but
    // it doubles the work for every footer change.
    expect(writtenFrames(out, 'footer-10')).toBe(2);
    // Silently, too: no clearing path is taken, so nothing flags the overrun.
    expect(eraseCount(out)).toBe(0);
  });

  it('clips the transcript to the space the footer leaves, however tall it is', async () => {
    const stdout = mkStdout();
    const app = render(<FlexShell footerLines={2} liveLines={500} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();
    const screen = emulate(stdout.getBuf(), COLS, ROWS);
    app.unmount();

    // A 500-row transcript must not produce a 500-row frame: the flex child of
    // a fixed-height parent is sized by the parent, so `overflow: hidden` has a
    // settled height to clip against.
    expect(screen.rows.length).toBeLessThan(ROWS);
    expect(screen.rows.at(-1)?.trim()).toBe('footer-1');
  });

  it('shows exactly one footer on screen after the footer grows', async () => {
    const stdout = mkStdout();
    const app = render(<FlexShell footerLines={3} liveLines={30} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    app.rerender(<FlexShell footerLines={11} liveLines={30} />);
    await tick();
    const out = stdout.getBuf();
    app.unmount();

    expect(visibleCopies(out, 'footer-10')).toBe(1);
    expect(visibleCopies(out, 'footer-0')).toBe(1);
  });

  it('never erases scrollback across a sequence of abrupt footer changes', async () => {
    const stdout = mkStdout();
    const app = render(<FlexShell footerLines={4} liveLines={200} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    for (const f of [9, 2, 14, 3, 11]) {
      app.rerender(<FlexShell footerLines={f} liveLines={200} />);
      await tick();
    }
    const erases = eraseCount(stdout.getBuf());
    app.unmount();

    // Clipping is what keeps ink off the repaint path that erases scrollback.
    expect(erases).toBe(0);
  });

  it('keeps the newest transcript row visible as the footer grows', async () => {
    const stdout = mkStdout();
    const app = render(<FlexShell footerLines={3} liveLines={200} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();

    app.rerender(<FlexShell footerLines={12} liveLines={200} />);
    await tick();
    const screen = emulate(stdout.getBuf(), COLS, ROWS);
    app.unmount();

    // Sticky scroll must still land on the last row after the region shrinks.
    expect(screen.rows.some((r) => r.trim() === 'live-199')).toBe(true);
  });
});
