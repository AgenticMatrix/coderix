import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, Box, Text, Static } from 'ink';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ScrollBox from '../scroll-viewport.js';
import type { ScrollBoxHandle } from '../scroll-viewport.js';
import { emulate } from '../testing/term-emulator.js';

/**
 * A short transcript must sit flush against BOTH of its neighbours: directly
 * under the committed turn it answers, and directly above the footer. There is
 * no third place for spare rows to go.
 *
 * WHY THIS IS NOT COSMETIC
 * The live region used to be `height={liveRows} shrinkToContent`. Moving it to
 * `flexGrow` to fix a separate defect (a measured footer height lags a frame,
 * which emitted a second stale frame) silently dropped that behaviour, since
 * `shrinkToContent` was documented as ignored without an explicit height. A
 * `flexGrow` child claims its entire share, so every reply — however short —
 * was laid out at the TOP of a full-height region with the unused rows as dead
 * space beneath it. That is what "the text jumps to the top of the window"
 * described: the text had not moved, the region around it had grown.
 *
 * THE SYMMETRICAL MISTAKE, WHICH IS WORSE
 * Bottom-aligning the content inside that full-height box (whether by
 * `justifyContent` or by offsetting the scroll margin) fixes the footer gap and
 * moves the very same dead rows ABOVE the reply, opening a chasm between it and
 * the committed turn. That is worse, not better: rows below the footer are
 * trailing and get trimmed, while rows above the reply are real output that
 * scrolls into terminal history permanently.
 *
 * Shrinking is what removes the rows instead of relocating them — the box is
 * only ever as tall as its content, so there are no spare rows to place.
 * Clipping still works because Yoga caps the box at the leftover space, giving
 * a tall transcript a resolved height smaller than its content, which is all
 * `overflow: hidden` needs.
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

const tick = () => new Promise((r) => setTimeout(r, 120));

const FOOTER = 'status-bar';

/**
 * Mirrors App.tsx: fixed root, committed history, shrinking live region, footer.
 *
 * `grow` and `bottomAlign` reproduce the two rejected layouts, so each can be
 * shown to produce the symptom it produced in the real app. `bottomAlign`
 * stands in for offsetting the content by the unused height; it is applied to a
 * plain Box because ScrollBox deliberately offers no such option.
 */
function Shell({
  lines,
  committed = [],
  grow = false,
  bottomAlign = false,
  footerExtra = 0,
  handleRef,
}: {
  lines: number;
  committed?: string[];
  grow?: boolean;
  bottomAlign?: boolean;
  footerExtra?: number;
  handleRef?: React.Ref<ScrollBoxHandle>;
}) {
  const rows = Array.from({ length: lines }, (_, i) => <Text key={i}>row-{i}</Text>);
  return (
    <Box flexDirection="column" height={ROWS - 1}>
      <Static items={committed}>{(c) => <Text key={c}>{c}</Text>}</Static>
      {bottomAlign ? (
        <Box
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          flexDirection="column"
          justifyContent="flex-end"
          overflow="hidden"
        >
          <Box flexDirection="column" flexShrink={0}>
            {rows}
          </Box>
        </Box>
      ) : (
        <ScrollBox
          ref={handleRef}
          {...(grow ? { flexGrow: 1 } : {})}
          flexShrink={1}
          minHeight={0}
          stickyScroll
        >
          {rows}
        </ScrollBox>
      )}
      <Box flexDirection="column" flexShrink={0}>
        {Array.from({ length: footerExtra }, (_, i) => (
          <Text key={i}>panel-{i}</Text>
        ))}
        <Text>{FOOTER}</Text>
      </Box>
    </Box>
  );
}

async function screenOf(element: React.ReactElement) {
  const stdout = mkStdout();
  const app = render(element, { stdout: stdout as never, patchConsole: false });
  await tick();
  const screen = emulate(stdout.getBuf(), COLS, ROWS);
  app.unmount();
  return {
    visible: screen.rows.map((r) => r.trim()),
    scrollback: screen.scrollback.map((r) => r.trim()),
    raw: stdout.getBuf(),
  };
}

describe('a short transcript in the live region', () => {
  it('sits directly above the footer, with no dead space below it', async () => {
    const { visible } = await screenOf(<Shell lines={3} />);
    const footer = visible.lastIndexOf(FOOTER);
    expect(footer, 'the footer must be on screen').toBeGreaterThan(-1);
    expect(
      visible.slice(footer - 3, footer),
      'the rows immediately before the footer are the transcript',
    ).toEqual(['row-0', 'row-1', 'row-2']);
  });

  it('sits directly below the committed turn, with no dead space above it', async () => {
    // Counting BLANK rows, not non-blank ones. An earlier version of this
    // assertion filtered the blanks out before checking the gap was empty,
    // which made it vacuous — blank filler is precisely the thing being looked
    // for. It passed against the bad fix it was written to catch.
    const { visible } = await screenOf(<Shell lines={2} committed={['> hello']} />);
    const answerTop = visible.indexOf('row-0');
    expect(answerTop, 'the answer must be on screen').toBeGreaterThan(-1);
    expect(
      visible.slice(0, answerTop),
      'no filler rows may separate the answer from the turn it answers',
    ).toEqual([]);
  });

  it('would show that gap if the region claimed the whole share and bottom-aligned', async () => {
    // The bad fix, reproduced locally so the mechanism is pinned behaviourally
    // rather than only by the source-text guard below.
    //
    // `bottomAlign` offsets the content by the unused height inside a
    // full-height box. That satisfies "hugs the footer" while pushing the same
    // dead rows ABOVE the answer — and unlike rows below the footer, which are
    // trailing and get trimmed, these are real output that scrolls into
    // terminal history for good. Strictly worse than the symptom it replaced.
    const { visible } = await screenOf(<Shell lines={2} committed={['> hello']} grow bottomAlign />);
    const answerTop = visible.indexOf('row-0');
    expect(answerTop, 'the answer is pushed far down the screen').toBeGreaterThan(5);
    expect(
      visible.slice(0, answerTop).every((r) => r === ''),
      'and everything above it is blank filler',
    ).toBe(true);
  });

  it('emits no blank filler rows into scrollback', async () => {
    // Rows above the reply are real output: they scroll into history and stay
    // there. Rows below the footer are trailing and get trimmed, which is why
    // the spare space must end up there and nowhere else.
    const { scrollback } = await screenOf(
      <Shell lines={2} committed={['> hello', '> and again']} />,
    );
    expect(
      scrollback.filter((r) => r === ''),
      'no blank rows may be committed to history',
    ).toEqual([]);
  });

  it('keeps the whole frame short rather than padding it out', async () => {
    const short = await screenOf(<Shell lines={3} />);
    // 3 transcript rows + 1 footer, with the rest trimmed as trailing blanks.
    expect(short.visible.length, 'a short turn uses a short frame').toBeLessThanOrEqual(6);
  });

  it('grows downward from the footer as the transcript lengthens', async () => {
    for (const lines of [1, 2, 5]) {
      const { visible } = await screenOf(<Shell lines={lines} />);
      const footer = visible.lastIndexOf(FOOTER);
      expect(visible[footer - 1], `${lines} rows: newest line hugs the footer`).toBe(
        `row-${lines - 1}`,
      );
    }
  });

  it('demonstrates that flexGrow is what opened the gap', async () => {
    // The control: the same shell with `flexGrow` restored. Pinning the
    // mechanism, so a future change that reinstates it is recognisable.
    const { visible } = await screenOf(<Shell lines={3} grow />);
    const footer = visible.lastIndexOf(FOOTER);
    expect(
      visible.slice(footer - 3, footer),
      'with flexGrow the rows before the footer are blank filler',
    ).toEqual(['', '', '']);
  });
});

describe('a transcript taller than the live region', () => {
  it('clips to the leftover space and keeps the newest row visible', async () => {
    const { visible, raw } = await screenOf(<Shell lines={200} />);
    expect(visible, 'sticky: the newest row is shown').toContain('row-199');
    expect(visible.at(-1)).toBe(FOOTER);
    expect(visible, 'the top is clipped, not squeezed in').not.toContain('row-0');
    // Clipping is the whole reason scrollback survives: a frame taller than the
    // viewport sends ink down its clear-everything path.
    expect(raw.match(/\x1b\[3J/g) ?? [], 'scrollback must never be erased').toEqual([]);
  });

  it('still clips when the footer grows, without overrunning the root', async () => {
    // The defect `flexGrow` was introduced to fix. Shrinking must not bring it
    // back: Yoga still resolves both in one pass, so only one frame is emitted.
    const { visible, raw } = await screenOf(<Shell lines={200} footerExtra={6} />);
    expect(visible.length, 'the frame stays within the root').toBeLessThanOrEqual(ROWS - 1);
    expect(
      visible.filter((r) => r === FOOTER),
      'exactly one footer — two means a second, stale frame',
    ).toHaveLength(1);
    expect(raw.match(/\x1b\[3J/g) ?? []).toEqual([]);
    expect(visible).toContain('row-199');
  });

  it('can still be scrolled to its top', async () => {
    // The `justifyContent: 'flex-end'` trap: bottom-alignment that overrides
    // the scroll margin renders identically at every scroll position, so it
    // bottom-aligns correctly and silently stops scrolling.
    const handle = React.createRef<ScrollBoxHandle>();
    const stdout = mkStdout();
    const app = render(<Shell lines={40} handleRef={handle} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    await tick();
    const atBottom = emulate(stdout.getBuf(), COLS, ROWS).rows.map((r) => r.trim());
    expect(atBottom, 'sticky: starts at the newest row').toContain('row-39');

    handle.current?.scrollToTop();
    await tick();
    const atTop = emulate(stdout.getBuf(), COLS, ROWS).rows.map((r) => r.trim());
    app.unmount();
    expect(atTop, 'scrolling to the top must actually reveal the first row').toContain('row-0');
  });
});

describe('the live region in App.tsx', () => {
  it('shrinks rather than claiming the whole leftover share', () => {
    // Both failure modes are call-site shaped and both pass every behavioural
    // test above, so the props themselves are pinned.
    const app = readFileSync(
      fileURLToPath(new URL('../../../coderix-cli/src/tui/components/App.tsx', import.meta.url)),
      'utf8',
    );
    const liveRegion = /<ScrollBox\b[\s\S]*?>/.exec(app)?.[0] ?? '';
    expect(liveRegion, 'the live ScrollBox must be found at all').toMatch(/scrollRef/);
    expect(liveRegion, 'it must be free to shrink').toMatch(/flexShrink/);
    expect(liveRegion, 'a flex child cannot shrink below its content without this').toMatch(
      /minHeight=\{0\}/,
    );
    expect(liveRegion, 'claiming the whole share is what top-aligns a short reply').not.toMatch(
      /flexGrow/,
    );
  });

  it('does not size the flush policy from the shrunken region', () => {
    // A shrunk box's height IS its content height, so `getViewportHeight()` as
    // the capacity makes `shouldFlush` compare content with itself and flush on
    // every frame. See `flush-capacity.test.ts`.
    const app = readFileSync(
      fileURLToPath(new URL('../../../coderix-cli/src/tui/components/App.tsx', import.meta.url)),
      'utf8',
    );
    const flushEffect = /const liveRegionRows =[^;]*;/.exec(app)?.[0] ?? '';
    expect(flushEffect, 'the capacity assignment must be found').not.toBe('');
    expect(flushEffect, 'capacity cannot come from the shrunken box itself').not.toMatch(
      /getViewportHeight/,
    );
  });
});
