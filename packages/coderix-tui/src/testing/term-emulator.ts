/**
 * A minimal ANSI screen model.
 *
 * Counting rows in a byte stream cannot answer "what does the user see": ink
 * repaints in place, so a frame that appears twice in the stream may be one
 * frame overwritten once. Only replaying the escapes against a screen buffer
 * distinguishes an in-place repaint from a stale frame left behind.
 *
 * Supports the subset ink's incremental writer emits: cursor up/down/next-line,
 * column addressing, line and screen erases, and scrolling on overflow.
 *
 * Columns are modelled per character via `charWidth`, and a write that would
 * pass the last column soft-wraps onto the next row — because that is how a
 * real terminal comes to hold more rows than ink believes it drew, which is
 * the mechanism behind every "old frame never erased, new frame drawn below"
 * defect this harness exists to catch.
 */
import { eastAsianWidthType } from 'get-east-asian-width';

export type Screen = {
  /** Visible rows, top to bottom, trailing blanks trimmed. */
  rows: string[];
  /** Rows pushed off the top — the terminal's scrollback. */
  scrollback: string[];
};

/** Width model matching `string-width` — what INK believes it drew. */
export function inkWidth(ch: string): number {
  const type = eastAsianWidthType(ch.codePointAt(0)!);
  return type === 'wide' || type === 'fullwidth' ? 2 : 1;
}

/**
 * Width model of a CJK-LOCALE terminal: East Asian Ambiguous glyphs resolve to
 * 2 columns, where ink's `string-width` resolves them to 1. Every glyph that
 * disagrees is one column of drift per occurrence, and a row that ink wrapped
 * to exactly the terminal width is one soft-wrapped row short of the truth.
 */
export function cjkLocaleWidth(ch: string): number {
  const type = eastAsianWidthType(ch.codePointAt(0)!);
  return type === 'wide' || type === 'fullwidth' || type === 'ambiguous' ? 2 : 1;
}

export type EmulateOptions = {
  /**
   * Display width of one character. Defaults to `inkWidth` (the accounting ink
   * paints against); pass `cjkLocaleWidth` to model an East Asian terminal.
   */
  charWidth?: (ch: string) => number;
};

export function emulate(
  input: string,
  cols: number,
  rows: number,
  options?: EmulateOptions,
): Screen {
  // `grid` models the VISIBLE screen only, never more than `rows` lines. Rows
  // pushed past the bottom move to `scrollback`, exactly as a terminal does —
  // keeping the two disjoint, so a row can never be counted as both.
  const grid: string[] = [''];
  const scrollback: string[] = [];
  let row = 0;
  let col = 0;

  /**
   * Grow the grid to reach the cursor, then scroll if that pushed it past the
   * last visible line. Scrolling moves the cursor up with the content, so `row`
   * stays within the viewport.
   */
  const ensure = () => {
    while (grid.length <= row) grid.push('');
    while (grid.length > rows) {
      scrollback.push(grid.shift()!);
      row -= 1;
    }
  };
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

  const widthOf = options?.charWidth ?? inkWidth;

  const write = (text: string) => {
    for (const ch of text) {
      const w = widthOf(ch);
      // A character that does not fit the remaining columns starts a new row,
      // exactly as a terminal soft-wraps — and exactly what ink fails to count.
      if (col + w > cols) {
        row += 1;
        col = 0;
        ensure();
      }
      ensure();
      const line = pad(grid[row]!, col);
      grid[row] = line.slice(0, col) + ch + line.slice(col + w);
      col += w;
    }
  };

  const newline = () => {
    row += 1;
    col = 0;
    ensure();
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;

    if (ch === '\x1b' && input[i + 1] === '[') {
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(input.slice(i));
      if (!m) { i += 1; continue; }
      const [full, rawArgs, cmd] = m as unknown as [string, string, string];
      const n = rawArgs === '' ? 1 : Number.parseInt(rawArgs, 10) || 0;
      i += full.length;

      switch (cmd) {
        case 'A': row = Math.max(0, row - n); break;            // cursor up
        case 'B': row += n; ensure(); break;                     // cursor down
        case 'C': col += n; break;
        case 'D': col = Math.max(0, col - n); break;
        case 'E': row += n; col = 0; ensure(); break;             // next line
        case 'F': row = Math.max(0, row - n); col = 0; break;
        case 'G': col = Math.max(0, n - 1); break;                // column
        case 'H': row = Math.max(0, n - 1); col = 0; ensure(); break;
        case 'K': {                                               // erase in line
          ensure();
          if (rawArgs === '' || n === 0) grid[row] = grid[row]!.slice(0, col);
          else if (n === 1) grid[row] = ' '.repeat(col) + grid[row]!.slice(col);
          else grid[row] = '';
          break;
        }
        case 'J': {                                               // erase in display
          ensure();
          if (n === 2 || n === 3) {
            grid.length = 0; grid.push(''); row = 0; col = 0;
            if (n === 3) scrollback.length = 0;
          } else if (n === 0) {
            grid.length = row + 1;
            grid[row] = grid[row]!.slice(0, col);
          }
          break;
        }
        default: break;                                           // SGR, ?2026, etc.
      }
      continue;
    }

    if (ch === '\n') { newline(); i += 1; continue; }
    if (ch === '\r') { col = 0; i += 1; continue; }
    if (ch === '\x1b') { i += 1; continue; }

    // Plain text run up to the next control character.
    let j = i;
    while (j < input.length && input[j] !== '\x1b' && input[j] !== '\n' && input[j] !== '\r') j += 1;
    write(input.slice(i, j));
    i = j;
  }

  const visible = grid.slice();
  while (visible.length && visible[visible.length - 1]!.trim() === '') visible.pop();
  return { rows: visible.map((r) => r.replace(/\s+$/, '')), scrollback };
}

/** How many times `needle` appears as a row on the visible screen. */
export function countRows(screen: Screen, needle: string): number {
  return screen.rows.filter((r) => r.trim() === needle).length;
}
