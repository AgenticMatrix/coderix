import stringWidth from 'string-width';

/**
 * Text measurement in terminal COLUMNS.
 *
 * `String.prototype.length` counts UTF-16 code units, which is the wrong unit
 * for a terminal in two independent ways: a CJK character occupies 2 columns
 * but 1 unit, and an emoji or a combining sequence occupies 1-2 columns but
 * several units. Chrome assembled by padding strings to a `.length` target is
 * therefore misaligned exactly when the content stops being ASCII.
 *
 * These helpers exist so callers building fixed-width chrome measure the same
 * way ink does when it decides how many rows it drew — see `safe-glyphs.ts` for
 * what happens when the two disagree.
 */

/** Width of `text` in terminal columns. */
export function textWidth(text: string): number {
  return stringWidth(text);
}

/**
 * Truncates `text` to at most `maxColumns` columns, marking the cut with `…`
 * (itself one column) when anything was removed.
 *
 * Grapheme-aware by construction: it accumulates whole code points and stops
 * before the budget is exceeded, so a 2-column character is never bisected into
 * a half-rendered cell. Returns `text` untouched when it already fits, so a
 * caller can apply it unconditionally.
 */
export function truncateToWidth(text: string, maxColumns: number): string {
  if (maxColumns <= 0) return '';
  if (stringWidth(text) <= maxColumns) return text;

  // One column is reserved for the ellipsis that signals the cut.
  const budget = maxColumns - 1;
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = stringWidth(char);
    if (used + w > budget) break;
    out += char;
    used += w;
  }
  return out + '…';
}

/**
 * Pads `text` with spaces to exactly `columns` columns, measuring in columns
 * rather than code units. Text already at or beyond the target is returned
 * unchanged — padding never truncates, so a caller that needs a hard ceiling
 * composes this with `truncateToWidth`.
 */
export function padToWidth(text: string, columns: number): string {
  const deficit = columns - stringWidth(text);
  return deficit > 0 ? text + ' '.repeat(deficit) : text;
}
