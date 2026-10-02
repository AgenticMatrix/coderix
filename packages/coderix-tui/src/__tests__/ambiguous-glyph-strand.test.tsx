import { describe, it, expect } from 'vitest';
import { Box, Text } from 'ink';
import { EventEmitter } from 'node:events';

import { renderSync } from '../render-entry.js';
import { emulate, inkWidth, cjkLocaleWidth } from '../testing/term-emulator.js';

/**
 * The duplication the bug reports show — a tool block rendered twice, the
 * activity line stacked with two different elapsed values, a neighbouring
 * tool block vanished — is not caused by anything the app draws wrong. It is
 * caused by the terminal and ink DISAGREEING about how many rows a frame has.
 *
 * Ink counts rows with `string-width`. A CJK-locale terminal resolves East
 * Asian **Ambiguous** glyphs to 2 columns where `string-width` says 1, so a
 * row ink believes exactly fills the terminal is one column too wide in the
 * terminal and soft-wraps onto a row ink never drew. Every rewind ink makes
 * afterwards stops short by that row, and the frame it meant to erase stays
 * on screen with the new frame drawn below it.
 *
 * The trigger is a change to the wrapped row ITSELF — the tool block's
 * blinking `●`/`○` indicator, or its text growing while a command streams in.
 * Rewriting a changed line lands one row lower than ink thinks, so the old
 * copy of the row survives below... which is exactly what the report shows.
 *
 * This test renders that situation with two width models — ink's, and a CJK
 * terminal's — and asserts duplication appears only where the disagreement
 * exists. It is the mechanism behind `safe-glyphs.ts`; the renderers that
 * still draw Ambiguous glyphs into repainted rows are the regression.
 */

const COLS = 40;
const ROWS = 24;

function fakeTty() {
  const chunks: string[] = [];
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & {
    written: () => string;
  };
  Object.assign(stream, {
    isTTY: true,
    columns: COLS,
    rows: ROWS,
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

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/**
 * A tool-block row shaped like the real ones: an Ambiguous status glyph
 * followed by enough text to fill the terminal width exactly, so that the
 * glyph's extra column in a CJK terminal soft-wraps the row. Beneath it sits
 * an activity row, as in the live tail.
 */
function Shell({ glyph, activity }: { glyph: string; activity: string }) {
  // '●' + 39 columns of text = string-width 40 = exactly the terminal.
  const row = `${glyph}${'x'.repeat(COLS - 1)}`;
  return (
    <Box flexDirection="column">
      <Text>{row}</Text>
      <Text dimColor>{activity}</Text>
    </Box>
  );
}

async function runTurn() {
  const stdout = fakeTty();
  const app = renderSync(<Shell glyph="●" activity="Executing... 34s" />, {
    stdout,
    stdin: fakeStdin(),
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle();

  // The indicator blinks and the timer advances: the wrapped row itself
  // changes, which is what mis-positions ink's rewrite.
  app.rerender(<Shell glyph="○" activity="Executing... 35s" />);
  await settle();
  app.unmount();
  await settle();

  return stdout.written();
}

/** How many rows on screen or in scrollback start with `glyph`. */
function rowsStartingWith(out: string, glyph: string, charWidth: (ch: string) => number) {
  const screen = emulate(out, COLS, ROWS, { charWidth });
  return [...screen.scrollback, ...screen.rows].filter((r) => r.startsWith(glyph)).length;
}

describe('a row whose width ink and the terminal disagree about', () => {
  it('is painted once in a terminal that agrees with string-width', async () => {
    const out = await runTurn();
    expect(rowsStartingWith(out, '●', inkWidth), 'the old indicator is gone').toBe(0);
    expect(rowsStartingWith(out, '○', inkWidth), 'the new indicator is in place').toBe(1);
  });

  it('strands the previous frame once an Ambiguous glyph double-widths it', async () => {
    const out = await runTurn();

    // The CJK terminal ends with BOTH the old ● row and the new ○ row on
    // screen — the old one never erased, the new one drawn below it. That is
    // the duplication the bug reports show; the agreeing terminal repaints in
    // place and holds only the new row.
    expect(rowsStartingWith(out, '●', cjkLocaleWidth), 'the old row was never erased').toBe(1);
    expect(rowsStartingWith(out, '○', cjkLocaleWidth), 'the new row was drawn below it').toBe(1);

    // Where they sit makes the mechanism legible: the old row is ABOVE the new
    // one rather than overwritten by it.
    const screen = emulate(out, COLS, ROWS, { charWidth: cjkLocaleWidth });
    const everywhere = [...screen.scrollback, ...screen.rows];
    const oldIdx = everywhere.findIndex((r) => r.startsWith('●'));
    const newIdx = everywhere.findIndex((r) => r.startsWith('○'));
    expect(oldIdx, 'the stranded copy sits above the fresh one').toBeLessThan(newIdx);
  });
});
