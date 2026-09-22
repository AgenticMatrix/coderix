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
export { useVirtualScroll } from './use-windowed-list.js';
export type { VirtualScrollOptions, VirtualScrollResult } from './use-windowed-list.js';

// Re-exported from `ink` for convenience / API compatibility.
export { useInput, measureElement, useBoxMetrics } from 'ink';
export type { DOMElement } from 'ink';
