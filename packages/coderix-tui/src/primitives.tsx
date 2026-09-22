import React from 'react';
import { Box as InkBox, Text as InkText, useWindowSize } from 'ink';
import type { DOMElement } from 'ink';
import { resolveColor } from './color-types.js';

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
 * `ansi:*` color spellings are normalized to chalk color names.
 */
export const Text = React.forwardRef<DOMElement, React.ComponentProps<typeof InkText>>(
  function Text(props, ref) {
    const next = { ...props } as Record<string, unknown>;
    if (next.color !== undefined) next.color = normalizeColor(next.color);
    if (next.backgroundColor !== undefined) next.backgroundColor = normalizeColor(next.backgroundColor);
    return React.createElement(InkText, { ...next, ref } as React.ComponentProps<typeof InkText>);
  },
);

export type DividerProps = {
  /** Width of the divider in characters. Defaults to terminal width. */
  width?: number;
  /** Color for the divider line. */
  color?: string;
  /** Character to repeat for the divider line. */
  char?: string;
  /** Padding to subtract from the width. */
  padding?: number;
  /** Optional title shown centered in the divider. */
  title?: string;
};

/**
 * A horizontal divider line.
 */
export function Divider({
  width,
  color,
  char = '─',
  padding = 0,
  title,
}: DividerProps): React.ReactNode {
  const { columns: terminalWidth } = useWindowSize();
  const effectiveWidth = Math.max(0, (width ?? terminalWidth) - padding);

  if (title) {
    const titleWidth = title.length + 2; // +2 for spaces around the title
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
