import React from 'react';
import { Box as InkBox, Text as InkText, useWindowSize } from 'ink';
import type { DOMElement } from 'ink';
import stringWidth from 'string-width';
import { resolveColor } from './color-types.js';
import { HORIZONTAL_RULE } from './safe-glyphs.js';

/**
 * The "inactive" gray used for `dimColor`. This replicates the previous
 * renderer's theme behavior: `dimColor` replaced the text color with the dark
 * theme's `inactive` token (`rgb(153,153,153)`), rather than emitting the ANSI
 * faint (`\x1b[2m`) attribute.
 */
const INACTIVE_COLOR = 'rgb(153,153,153)' as const;

/**
 * Color-bearing props that need `ansi:*` normalization before they reach
 * ink's chalk-backed colorizer.
 */
const BOX_COLOR_KEYS = [
  'borderColor',
  'borderTopColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderRightColor',
  'backgroundColor',
  'borderBackgroundColor',
  'borderTopBackgroundColor',
  'borderBottomBackgroundColor',
  'borderLeftBackgroundColor',
  'borderRightBackgroundColor',
] as const;

function normalizeColor(value: unknown): unknown {
  return typeof value === 'string' ? resolveColor(value) : value;
}

/**
 * `Box` — a layout container, identical to `ink`'s Box except that
 * `ansi:*` color spellings are normalized to chalk color names.
 */
export const Box = React.forwardRef<DOMElement, React.ComponentProps<typeof InkBox>>(
  function Box(props, ref) {
    const next = { ...props } as Record<string, unknown>;
    for (const key of BOX_COLOR_KEYS) {
      if (next[key] !== undefined) next[key] = normalizeColor(next[key]);
    }
    return React.createElement(InkBox, { ...next, ref } as React.ComponentProps<typeof InkBox>);
  },
);

/**
 * `Text` — displays styled text, identical to `ink`'s Text except that
 * `ansi:*` color spellings are normalized and `dimColor` replicates the old
 * renderer's "replace color with inactive gray" semantics (overriding any
 * explicit `color`, and never emitting the ANSI faint attribute).
 */
export const Text = React.forwardRef<DOMElement, React.ComponentProps<typeof InkText>>(
  function Text(props, ref) {
    const next = { ...props } as Record<string, unknown>;
    if (props.dimColor) {
      next.color = INACTIVE_COLOR;
      next.dimColor = false;
    } else if (next.color !== undefined) {
      next.color = normalizeColor(next.color);
    }
    if (next.backgroundColor !== undefined) next.backgroundColor = normalizeColor(next.backgroundColor);
    return React.createElement(InkText, { ...next, ref } as React.ComponentProps<typeof InkText>);
  },
);

export type DividerProps = {
  /** Width of the divider in characters. Defaults to terminal width. */
  width?: number;
  /** Color for the divider line. */
  color?: string;
  /**
   * Character to repeat for the divider line.
   *
   * Defaults to `HORIZONTAL_RULE` (U+23AF ⎯), which is East Asian **Neutral** —
   * exactly 1 column in every terminal. The conventional choice, U+2500 ─, is
   * **Ambiguous**: 1 column to `string-width` but 2 in a CJK-locale terminal.
   * Since a divider spans the whole terminal width, that would double its
   * length and wrap it onto a second row that ink does not know it drew,
   * corrupting every subsequent in-place repaint. Override only with another
   * single-column glyph — see `safe-glyphs.ts`.
   */
  char?: string;
  /** Padding to subtract from the width. */
  padding?: number;
  /** Optional title shown centered in the divider. */
  title?: string;
};

/**
 * A horizontal divider line, optionally with a centered title.
 */
export function Divider({
  width,
  color,
  char = HORIZONTAL_RULE,
  padding = 0,
  title,
}: DividerProps): React.ReactNode {
  const { columns: terminalWidth } = useWindowSize();
  const effectiveWidth = Math.max(0, (width ?? terminalWidth) - padding);

  if (title) {
    // Measure in display columns, not code units: `.length` counts a wide CJK
    // title character as 1, which would make the rule overshoot and wrap.
    const titleWidth = stringWidth(title) + 2; // +2 for the spaces around it
    const sideWidth = Math.max(0, effectiveWidth - titleWidth);
    const leftWidth = Math.floor(sideWidth / 2);
    const rightWidth = sideWidth - leftWidth;
    return (
      <Text color={color} dimColor={!color}>
        {char.repeat(leftWidth)} <Text dimColor>{title}</Text> {char.repeat(rightWidth)}
      </Text>
    );
  }

  return (
    <Text color={color} dimColor={!color}>
      {char.repeat(effectiveWidth)}
    </Text>
  );
}
