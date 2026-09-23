// Coderix terminal UI primitives — clean-room layer over MIT `ink`.

// Rendering entry.
export { renderSync } from './render-entry.js';
export type { Instance, RenderOptions } from './render-entry.js';

// Primitives.
export { Box, Text, Divider } from './primitives.js';
export type { DividerProps } from './primitives.js';

// Color types and normalization.
export { resolveColor } from './color-types.js';
export type { Color } from './color-types.js';

// Terminal size hook.
export { useTerminalSize } from './use-viewport-size.js';
export type { TerminalSize } from './use-viewport-size.js';

// Scroll viewport + virtualization.
export { default as ScrollBox } from './scroll-viewport.js';
export type { ScrollBoxHandle, ScrollBoxProps } from './scroll-viewport.js';
export { useVirtualScroll, MeasuredItem } from './use-windowed-list.js';
export type { VirtualScrollOptions, VirtualScrollResult } from './use-windowed-list.js';

// Column-stable glyphs for repainted chrome. See safe-glyphs.ts for why East
// Asian Ambiguous-width characters corrupt in-place repaints.
export {
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
  SAFE_BORDER,
  SAFE_BORDER_ASCII,
  AMBIGUOUS_TO_SAFE,
  toSafeGlyphs,
} from './safe-glyphs.js';

// Re-exported from `ink` for convenience / API compatibility.
export { useInput, measureElement, useBoxMetrics } from 'ink';
export type { DOMElement } from 'ink';

// Append-only committed output. See `static-region.tsx`.
export { Static } from './static-region.js';
export type { StaticProps } from './static-region.js';
