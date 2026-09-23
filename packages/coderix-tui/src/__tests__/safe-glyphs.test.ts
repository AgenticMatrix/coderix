import { describe, it, expect } from 'vitest';
import { eastAsianWidthType } from 'get-east-asian-width';
import stringWidth from 'string-width';

import {
  VERTICAL_SEPARATOR,
  HORIZONTAL_RULE,
  GAUGE_FILLED,
  GAUGE_EMPTY,
  MARKER_SOLID,
  MARKER_HOLLOW,
  DOT_SEPARATOR,
  ELLIPSIS,
  ARROW_UP,
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  CORNER_TOP_LEFT,
  CORNER_TOP_RIGHT,
  CORNER_BOTTOM_LEFT,
  CORNER_BOTTOM_RIGHT,
  AMBIGUOUS_TO_SAFE,
  toSafeGlyphs,
} from '../safe-glyphs.js';

/**
 * These glyphs are drawn into chrome that ink repaints in place. Ink rewinds the
 * cursor by the row count it derives from `string-width`, so any glyph the
 * terminal draws wider than `string-width` reports will soft-wrap the row, leave
 * ink's rewind short, and strand the previous frame on screen.
 *
 * East Asian **Ambiguous** is exactly that trap: `string-width` resolves it to
 * 1 column, a CJK-locale terminal to 2. So the invariant is not merely
 * "width === 1" — it is "width === 1 *and* no locale can change that".
 */
const SAFE_GLYPHS = {
  VERTICAL_SEPARATOR,
  HORIZONTAL_RULE,
  GAUGE_FILLED,
  GAUGE_EMPTY,
  MARKER_SOLID,
  MARKER_HOLLOW,
  DOT_SEPARATOR,
  ELLIPSIS,
  ARROW_UP,
  ARROW_DOWN,
  ARROW_LEFT,
  ARROW_RIGHT,
  CORNER_TOP_LEFT,
  CORNER_TOP_RIGHT,
  CORNER_BOTTOM_LEFT,
  CORNER_BOTTOM_RIGHT,
};

/** Width classes whose rendered column count depends on locale or is 2. */
const UNSAFE_WIDTH_TYPES = new Set(['ambiguous', 'wide', 'fullwidth']);

describe('safe-glyphs', () => {
  describe('exported constants are locale-independent single-column', () => {
    for (const [name, glyph] of Object.entries(SAFE_GLYPHS)) {
      it(`${name} (${glyph}) is one column in every locale`, () => {
        expect([...glyph]).toHaveLength(1);

        const widthType = eastAsianWidthType(glyph.codePointAt(0)!);
        expect(
          UNSAFE_WIDTH_TYPES.has(widthType),
          `${name} is U+${glyph
            .codePointAt(0)!
            .toString(16)
            .toUpperCase()
            .padStart(4, '0')} with East Asian width "${widthType}". A CJK-locale ` +
            `terminal may draw it 2 columns wide, which wraps repainted chrome. ` +
            `Pick a Neutral or Narrow glyph instead.`,
        ).toBe(false);

        expect(stringWidth(glyph)).toBe(1);
      });
    }
  });

  describe('AMBIGUOUS_TO_SAFE', () => {
    it('only maps glyphs that are genuinely ambiguous', () => {
      for (const from of Object.keys(AMBIGUOUS_TO_SAFE)) {
        expect(
          eastAsianWidthType(from.codePointAt(0)!),
          `"${from}" is a mapping key but is not ambiguous, so mapping it away ` +
            `changes the glyph for no reason.`,
        ).toBe('ambiguous');
      }
    });

    it('maps every glyph to a locale-independent single-column target', () => {
      for (const [from, to] of Object.entries(AMBIGUOUS_TO_SAFE)) {
        const widthType = eastAsianWidthType(to.codePointAt(0)!);
        expect(
          UNSAFE_WIDTH_TYPES.has(widthType),
          `"${from}" maps to "${to}", which has East Asian width "${widthType}" — ` +
            `that reintroduces the very wrapping bug the mapping exists to prevent.`,
        ).toBe(false);
        expect(stringWidth(to)).toBe(1);
      }
    });

    it('is idempotent: no target is itself a key', () => {
      // Otherwise `toSafeGlyphs` would depend on iteration order to converge.
      for (const to of Object.values(AMBIGUOUS_TO_SAFE)) {
        expect(AMBIGUOUS_TO_SAFE[to]).toBeUndefined();
      }
    });
  });

  describe('toSafeGlyphs', () => {
    it('substitutes ambiguous chrome glyphs', () => {
      expect(toSafeGlyphs('│─█●○·')).toBe(
        `${VERTICAL_SEPARATOR}${HORIZONTAL_RULE}${GAUGE_FILLED}${MARKER_SOLID}${MARKER_HOLLOW}${DOT_SEPARATOR}`,
      );
    });

    it('leaves ASCII untouched', () => {
      const input = 'ctx 42% 15K/1M | model: gpt-5 | procs 1';
      expect(toSafeGlyphs(input)).toBe(input);
    });

    it('preserves CJK text, where being wide is correct', () => {
      // Real content should never be mangled — only chrome glyphs are remapped.
      expect(toSafeGlyphs('正在执行任务')).toBe('正在执行任务');
    });

    it('preserves glyphs that are already Neutral', () => {
      // ░ ◉ ⏲ ⚠ ❯ are Neutral: 1 column everywhere, so they are not part of
      // the bug and must not be substituted.
      expect(toSafeGlyphs('░◉⏲⚠❯')).toBe('░◉⏲⚠❯');
    });

    it('does not change the rendered width of a string', () => {
      const input = '│ ctx ████░░░░ 40% │ procs 1 │';
      expect(stringWidth(toSafeGlyphs(input))).toBe(stringWidth(input));
    });

    it('is a no-op on its own output', () => {
      const once = toSafeGlyphs('┌──┬──┐ ● ○ · │');
      expect(toSafeGlyphs(once)).toBe(once);
    });

    it('handles an empty string', () => {
      expect(toSafeGlyphs('')).toBe('');
    });

    it('does not split surrogate pairs', () => {
      // Iterating by code point, not code unit, keeps astral glyphs intact.
      expect(toSafeGlyphs('🚀 done')).toBe('🚀 done');
    });
  });
});
