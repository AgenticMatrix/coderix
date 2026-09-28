import React from 'react';
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  renderSync,
  textWidth,
  VERTICAL_SEPARATOR,
  HORIZONTAL_RULE,
  CORNER_TOP_LEFT,
  CORNER_TOP_RIGHT,
  CORNER_BOTTOM_LEFT,
  CORNER_BOTTOM_RIGHT,
} from '@coderix/tui';
import { HeaderLogo } from '../HeaderLogo.js';

/**
 * The banner must never be wider than the terminal.
 *
 * WHY THIS IS NOT COSMETIC
 * The banner is a fixed-width box assembled from strings: the art column is
 * padded to `artMaxLen`, the info column to `rightMaxLen`, and both borders are
 * drawn to match. Every one of those widths was derived from the CONTENT with
 * no upper bound, so the box was as wide as its longest line needed — 123
 * columns, driven by a skill description.
 *
 * In any terminal narrower than that, EVERY row soft-wraps. Not one row: all of
 * them, because they are all padded to the same over-wide length. An 18-row
 * banner becomes 36 rows of output, which is what pushed it off the top of the
 * screen at startup. The banner had not moved; it had silently doubled.
 *
 * It is also the one piece of chrome that cannot be repaired by a later frame:
 * it is the first `<Static>` item, printed once directly into scrollback. A
 * wrapped banner stays wrapped in the terminal's history for the rest of the
 * session.
 *
 * Measured in COLUMNS (`string-width`), never `.length`. The skill descriptions
 * that drive the width contain `—` and `…`, and a CJK workspace path would make
 * the two diverge by a factor of two.
 */

const tick = () => new Promise((r) => setTimeout(r, 150));

type Rendered = { rows: string[]; widest: number };

async function renderAt(columns: number): Promise<Rendered> {
  const stdout = new PassThrough() as unknown as {
    isTTY: boolean;
    columns: number;
    rows: number;
    on: (e: string, h: (c: Buffer) => void) => void;
  };
  stdout.isTTY = true;
  stdout.columns = columns;
  // Tall enough that nothing is clipped by the viewport: this measures the
  // banner's own size, not what survives a short screen.
  stdout.rows = 200;
  let buf = '';
  stdout.on('data', (c: Buffer) => {
    buf += c.toString();
  });

  const app = renderSync(<HeaderLogo />, {
    stdout: stdout as never,
    stdin: new PassThrough() as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await tick();
  app.unmount();

  const rows = buf
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    // Trailing blanks are an artefact of the write, not banner rows.
    .filter((line, i, all) => !(line.trim() === '' && i >= all.length - 2));

  return { rows, widest: Math.max(...rows.map((r) => textWidth(r))) };
}

/** Widths a real user actually has. 80 and 120 are the common defaults. */
const WIDTHS = [80, 100, 120, 160];

/**
 * A row made up entirely of frame glyphs — the top or bottom rule.
 *
 * Assembled from the exported constants rather than written out, so restyling
 * the chrome (dashed `╎` to solid `⎸`, say) cannot leave this matching nothing
 * and reporting a vacuous pass.
 */
const BORDER_ROW = new RegExp(
  `^[\\s${[
    CORNER_TOP_LEFT,
    CORNER_TOP_RIGHT,
    CORNER_BOTTOM_LEFT,
    CORNER_BOTTOM_RIGHT,
    HORIZONTAL_RULE,
  ].join('')}]+$`,
);

describe('the startup banner', () => {
  it('draws each border as a single unwrapped row', async () => {
    // NOT "is every row narrower than the terminal" — that assertion cannot
    // fail. Ink wraps by inserting real newlines, so the rows reaching stdout
    // are always within the width by construction; measuring them back proves
    // only that wrapping happened, not that it didn't. (Written that way
    // first, it passed against the very defect it was meant to catch.)
    //
    // The border is the honest probe: it is one continuous run of rule glyphs
    // emitted as a single `<Text>`, so it occupies exactly one row if and only
    // if the box fits. When it doesn't, the tail spills onto a row of its own.
    //
    // The glyph set is built from the constants, so restyling the chrome cannot
    // silently stop this from matching anything — which would make the count
    // zero and the assertion fail loudly, rather than pass vacuously.
    for (const columns of WIDTHS) {
      const { rows } = await renderAt(columns);
      const borderRows = rows.filter((r) => BORDER_ROW.test(r) && r.trim() !== '');
      expect(
        borderRows.length,
        `at ${columns} columns: expected exactly 2 border rows (top and bottom), got ${borderRows.length} — a wrapped border means the banner is wider than the terminal`,
      ).toBe(2);
    }
  });

  it('stays one screen-line per banner-line at every width', async () => {
    // The symptom, stated as a row count. Wrapping does not drop content, it
    // DOUBLES it — so the row count is the thing to pin. A banner that fits is
    // the same height at 80 columns as at 160.
    const wide = await renderAt(160);
    for (const columns of WIDTHS) {
      const { rows } = await renderAt(columns);
      expect(
        rows.length,
        `at ${columns} columns the banner must not wrap into extra rows`,
      ).toBe(wide.rows.length);
    }
  });

  it('fits on a standard 24-row screen', async () => {
    // Its whole purpose is to be seen at startup. The root is `rows - 1`, and
    // the footer (divider + input + status bar) claims several more, so a
    // banner taller than ~19 rows cannot be on screen at 24 rows.
    const { rows } = await renderAt(80);
    expect(rows.length, 'the banner must leave room for the footer').toBeLessThanOrEqual(19);
  });

  it('keeps its frame intact when the terminal is narrow', async () => {
    // Truncating must clip the CONTENT, not corrupt the box: a row that lost
    // its closing separator means the border was cut instead of the text.
    //
    // The separator is read from the constant rather than written out as a
    // literal. A literal makes this assertion fail whenever the glyph is
    // restyled — which it was, from dashed `╎` to solid `⎸` — reporting a
    // cosmetic change as a broken border.
    const { rows } = await renderAt(80);
    const body = rows.filter((r) => r.includes('CodeRix') || r.includes('workspace:'));
    expect(body.length, 'the info column must still be rendered').toBeGreaterThan(0);
    for (const row of body) {
      expect(
        row.trimEnd().endsWith(VERTICAL_SEPARATOR),
        `row must keep its right border: ${row}`,
      ).toBe(true);
    }
  });

  it('still shows the full banner when the terminal is wide enough', async () => {
    // Truncation must not be unconditional — a wide terminal loses nothing.
    const { rows } = await renderAt(200);
    const joined = rows.join('\n');
    expect(joined, 'the version line survives in full').toContain('CodeRix');
    expect(joined, 'the skills section survives').toContain('skills:');
  });
});
