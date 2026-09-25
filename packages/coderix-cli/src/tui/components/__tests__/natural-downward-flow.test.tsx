import React from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { Box, Text, Static, ScrollBox, renderSync } from '@coderix/tui';
import type { ScrollBoxHandle } from '@coderix/tui';
import { emulate } from '@coderix/tui/testing';

/**
 * THE CONTENT FLOWS DOWN, AND THE INPUT BOX FOLLOWS IT.
 *
 * WHAT THIS REPLACES, AND WHY BOTH EARLIER ANSWERS WERE WRONG
 * The frame had a fixed `height={rows - 1}`, so it claimed the whole screen no
 * matter how little was in it. That left spare rows that could not be deleted,
 * only placed, and the two placements are the two symptoms I shipped:
 *
 *   - spare rows BELOW the reply  -> a chasm between the answer and the input box
 *   - spare rows ABOVE the reply  -> the answer shoved to the bottom, and (with
 *                                    a fixed root) the banner pushed off-screen
 *
 * Neither is what a terminal does. A terminal prints a short answer and leaves
 * the prompt directly beneath it, wherever that happens to be. The frame must
 * therefore be as tall as its CONTENT, not as tall as the screen — then there
 * are no spare rows to place at all.
 *
 * WHY THE CEILING IS STILL REQUIRED
 * A frame taller than the viewport sends ink down `clearTerminal`, which
 * includes `ESC[3J` — *erase scrollback*. Once a transcript passes one screen,
 * an unbounded frame overflows on EVERY frame and the user's scroll history is
 * destroyed continuously. Measured on the flowing layout without a ceiling:
 * `ESC[3J` emitted, 30 rows of live content.
 *
 * So the root gets `maxHeight` rather than `height`. Yoga treats it as a
 * constraint, not a size: short content flows to its natural height, and tall
 * content makes the `flexShrink` live region give way in the SAME layout pass.
 * Nothing is measured, so no frame is ever built from a stale height.
 *
 * WHY NOT `maxHeight` ON THE LIVE REGION INSTEAD
 * Because its ceiling is `root - spacer - footer`, and the footer's height is
 * only knowable by measuring it — and `useBoxMetrics` reports from an effect, so
 * a height read during render describes the PREVIOUS layout. On the frame where
 * a footer panel appears the two disagree and the frame overruns. Measured: the
 * two are identical in every scenario here, so the one that needs no
 * measurement wins.
 *
 * WHY `flexGrow` AND `bottomAlign` ARE GONE
 * Both existed only to manage spare rows. `flexGrow` made the region claim the
 * leftover share (which kept the footer on the last SCREEN row, since the frame
 * was full-height regardless); `bottomAlign` then pushed the spare rows above
 * the reply. With a flowing root there is no leftover share, so `flexGrow` would
 * re-inflate the frame to full height and reintroduce the very gap it was
 * papering over. Measured: with a flowing root, `bottomAlign` changes nothing —
 * the input box lands on the same row either way.
 */

const COLS = 80;
const ROWS = 24;
const ROOT_MAX = ROWS - 1;
const tick = () => new Promise((r) => setTimeout(r, 200));

const DIVIDER = '--divider--';
const INPUT = '[INPUT BOX]';
const STATUS = '--status bar--';

function mkStdout() {
  const s = new PassThrough() as unknown as {
    isTTY: boolean;
    columns: number;
    rows: number;
    on: (e: string, h: (c: Buffer) => void) => void;
    getBuf: () => string;
  };
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

/**
 * Mirrors App.tsx's root: a FLOWING frame with a ceiling, a spacer, committed
 * history, the live region, then the footer.
 *
 * `fixedRoot` reproduces the rejected layout (`height` instead of `maxHeight`,
 * plus the `flexGrow` region it required) so the defect is demonstrated here
 * rather than only guarded in source.
 */
function Shell({
  committed = [],
  live,
  banner = [],
  footerExtra = 0,
  fixedRoot = false,
  handleRef,
}: {
  committed?: string[];
  live: string[];
  banner?: string[];
  footerExtra?: number;
  fixedRoot?: boolean;
  handleRef?: React.Ref<ScrollBoxHandle>;
}) {
  return (
    <Box
      flexDirection="column"
      {...(fixedRoot ? { height: ROOT_MAX } : { maxHeight: ROOT_MAX })}
    >
      <Box height={1} flexShrink={0} />
      <Static items={[...banner, ...committed]}>{(c) => <Text key={c}>{c}</Text>}</Static>
      <ScrollBox
        ref={handleRef}
        {...(fixedRoot ? { flexGrow: 1, bottomAlign: true } : {})}
        flexShrink={1}
        minHeight={0}
        stickyScroll
        paddingX={1}
      >
        {live.map((l) => (
          <Text key={l}>{l}</Text>
        ))}
      </ScrollBox>
      <Box flexDirection="column" flexShrink={0}>
        {Array.from({ length: footerExtra }, (_, i) => (
          <Text key={i}>panel-{i}</Text>
        ))}
        <Text>{DIVIDER}</Text>
        <Text>{INPUT}</Text>
        <Text>{STATUS}</Text>
      </Box>
    </Box>
  );
}

type Shot = {
  /** ABSOLUTE screen row of each landmark, or -1 when off-screen. */
  input: number;
  status: number;
  divider: number;
  /** ABSOLUTE screen row of the LAST live content row. */
  lastLive: number;
  rows: string[];
  text: string;
  scrollbackBlanks: number;
  clears: number;
};

const LIVE = /\b(?:row|T)-?\d/;

function shoot(buf: string): Shot {
  const screen = emulate(buf, COLS, ROWS);
  const rows = screen.rows;
  const find = (needle: string) => rows.findIndex((r) => r.includes(needle));
  const rev = [...rows].reverse().findIndex((r) => LIVE.test(r));
  return {
    input: find(INPUT),
    status: find(STATUS),
    divider: find(DIVIDER),
    lastLive: rev < 0 ? -1 : rows.length - 1 - rev,
    rows,
    text: rows.join('\n'),
    scrollbackBlanks: screen.scrollback.filter((r) => r.trim() === '').length,
    clears: (buf.match(/\x1b\[3J/g) ?? []).length,
  };
}

async function once(props: React.ComponentProps<typeof Shell>) {
  const stdout = mkStdout();
  const inst = renderSync(<Shell {...props} />, {
    stdout: stdout as never,
    stdin: new PassThrough() as never,
    incrementalRendering: true,
    maxFps: 60,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await tick();
  const shot = shoot(stdout.getBuf());
  inst.unmount();
  return shot;
}

/** Renders one instance and steps it through `turns`, sampling after each. */
async function session(
  turns: Partial<React.ComponentProps<typeof Shell>>[],
  base: Partial<React.ComponentProps<typeof Shell>> = {},
) {
  const stdout = mkStdout();
  const mk = (t: Partial<React.ComponentProps<typeof Shell>>) => (
    <Shell live={[]} {...base} {...t} />
  );
  const inst = renderSync(mk(turns[0]!), {
    stdout: stdout as never,
    stdin: new PassThrough() as never,
    incrementalRendering: true,
    maxFps: 60,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await tick();
  const shots: Shot[] = [];
  for (const [i, turn] of turns.entries()) {
    if (i > 0) {
      inst.rerender(mk(turn));
      await tick();
    }
    shots.push(shoot(stdout.getBuf()));
  }
  inst.unmount();
  return shots;
}

const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `row-${String(i + from).padStart(2, '0')}`);

describe('a short answer', () => {
  it('leaves the input box directly beneath it, near the TOP of the screen', async () => {
    // The claim the fixed-height root could not make. With 1 spacer + 2 live
    // rows + 3 footer rows there are 6 rows of content, so the input box belongs
    // on screen row 4 — not row 21 with seventeen rows of nothing in between.
    const shot = await once({ live: rows(2) });
    expect(shot.lastLive, 'the answer must be on screen').toBeGreaterThan(-1);
    expect(
      shot.divider - shot.lastLive - 1,
      'no blank rows between the newest line and the divider',
    ).toBe(0);
    expect(
      shot.input,
      'a 6-row frame must not be padded out to the full screen: the input box follows the content up, it does not sit at the bottom with a chasm above it',
    ).toBeLessThan(8);
    expect(shot.status, 'the status bar is the last row of the frame').toBe(shot.rows.length - 1);
  });

  it('is pushed to the bottom of the screen when the root height is fixed', async () => {
    // The rejected layout, reproduced. A full-height frame has spare rows it
    // cannot delete: `bottomAlign` puts them above the answer, so the answer and
    // the input box are both shoved to the bottom of the screen.
    const shot = await once({ live: rows(2), fixedRoot: true });
    expect(
      shot.input,
      'with a fixed-height root the input box is pinned to the bottom regardless of content',
    ).toBeGreaterThan(18);
  });

  it('does not lose the committed turn it answers off the top of the screen', async () => {
    // What the user saw as "the banner is pushed outside the window". A
    // full-height frame anchors to the BOTTOM of the terminal, so everything
    // already printed is scrolled off to make room for rows that are blank.
    const flowing = await once({ banner: rows(6, 90), live: rows(2) });
    const fixed = await once({ banner: rows(6, 90), live: rows(2), fixedRoot: true });
    expect(flowing.rows.some((r) => r.includes('row-90')), 'the flowing frame keeps it').toBe(true);
    expect(
      fixed.rows.some((r) => r.includes('row-90')),
      'the fixed-height frame scrolls it away — the defect',
    ).toBe(false);
  });
});

describe('as the answer grows', () => {
  it('the input box moves DOWN, never up', async () => {
    // The user's words: 内容跟着往下, 而不是输入框跟着往上.
    const shots = await session([2, 4, 7, 11].map((n) => ({ live: rows(n) })));
    const positions = shots.map((s) => s.input);
    expect(positions.every((p) => p > -1), `the input box left the screen: ${positions}`).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(
        positions[i]!,
        `growing the answer moved the input box UP (${positions[i - 1]} -> ${positions[i]}): ${positions}`,
      ).toBeGreaterThan(positions[i - 1]!);
    }
  });

  it('the newest line stays flush against the divider throughout', async () => {
    const shots = await session([1, 3, 6, 10, 40].map((n) => ({ live: rows(n) })));
    for (const [i, s] of shots.entries()) {
      expect(s.divider - s.lastLive - 1, `step ${i}: a gap opened above the divider`).toBe(0);
    }
  });

  it('stops growing at the screen edge instead of erasing scrollback', async () => {
    // The ceiling. Without it the frame keeps growing past the viewport and ink
    // takes its clear-everything path on every frame.
    const shots = await session([5, 20, 60, 200].map((n) => ({ live: rows(n) })));
    for (const [i, s] of shots.entries()) {
      expect(s.clears, `step ${i}: scrollback was erased (ESC[3J)`).toBe(0);
      expect(s.rows.length, `step ${i}: the frame overran the viewport`).toBeLessThanOrEqual(
        ROOT_MAX,
      );
    }
    const last = shots.at(-1)!;
    expect(last.text, 'sticky: the newest row is shown').toContain('row-199');
    expect(last.text, 'the top is clipped, not squeezed').not.toContain('row-00');
  });

  it('never commits blank filler rows to history', async () => {
    const shots = await session([2, 5, 9].map((n) => ({ live: rows(n) })));
    for (const [i, s] of shots.entries()) {
      expect(s.scrollbackBlanks, `step ${i}: blank rows leaked into scrollback`).toBe(0);
    }
  });
});

describe('the ceiling', () => {
  it('yields to a footer that grows, in a single layout pass', async () => {
    // The defect `flexGrow` was originally introduced to fix: a footer measured
    // for LAYOUT lags a frame, so a second, stale frame gets emitted. Yoga
    // resolves a `maxHeight` root and a `flexShrink` child together, so there is
    // nothing to lag.
    const shot = await once({ live: rows(200), footerExtra: 6 });
    expect(shot.rows.length, 'the frame stays within the viewport').toBeLessThanOrEqual(ROOT_MAX);
    expect(
      shot.rows.filter((r) => r.includes(STATUS)),
      'exactly one status bar — two means a second, stale frame',
    ).toHaveLength(1);
    expect(shot.clears, 'and scrollback survives').toBe(0);
    expect(shot.text, 'the newest row is still shown').toContain('row-199');
  });

  it('leaves the live region scrollable once it is clipped', async () => {
    // A shrunk-by-Yoga region must still resolve a height that `overflow:
    // hidden` can clip against, and the scroll offset must still apply. If the
    // region were sized by its children instead, it would be exactly as tall as
    // they are and would render identically at every scroll position.
    const handle = React.createRef<ScrollBoxHandle>();
    const stdout = mkStdout();
    const inst = renderSync(<Shell live={rows(60)} handleRef={handle} />, {
      stdout: stdout as never,
      stdin: new PassThrough() as never,
      incrementalRendering: true,
      maxFps: 60,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await tick();
    const atBottom = shoot(stdout.getBuf());
    expect(atBottom.text, 'sticky: starts at the newest row').toContain('row-59');

    handle.current?.scrollToTop();
    await tick();
    const atTop = shoot(stdout.getBuf());
    inst.unmount();

    expect(
      atTop.text,
      'scrolling to the top must actually reveal the first row — an identical render means the region never resolved a clipping height',
    ).toContain('row-00');
    expect(atTop.text, 'and the bottom rows must be gone').not.toContain('row-59');
    expect(atTop.clears, 'scrolling must not erase scrollback either').toBe(0);
  });
});
