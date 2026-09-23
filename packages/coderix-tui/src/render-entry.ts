import { render } from 'ink';
import type { Instance, RenderOptions } from 'ink';
import type { ReactNode } from 'react';

export type { Instance, RenderOptions } from 'ink';

/**
 * Mount a component and render it to the terminal. Wraps `ink`'s `render`,
 * which returns the instance synchronously (hence "sync").
 *
 * `incrementalRendering` enables ink's built-in per-line diff writer: it
 * compares each new frame against the previous one and rewrites only the lines
 * that actually changed. This preserves the terminal's native text selection
 * across re-renders and avoids the full-frame erase/redraw of the default
 * writer.
 *
 * Crucially, this diffing happens *inside* ink, which owns the terminal cursor
 * and knows the true rendered width of every line (wide CJK glyphs, graphemes,
 * soft wrapping at the terminal edge). An external wrapper around stdout cannot
 * know any of that: it would have to strip ink's cursor-control sequences and
 * re-derive positions itself, which desynchronizes from the real cursor and
 * produces overlapping / garbled frames. Do not reintroduce such a layer —
 * configure ink instead, or fix the layout that makes ink repaint.
 *
 * `maxFps` is raised to 60 to match the previous renderer's frame interval
 * (~16ms). Caller options win, so explicit overrides are still respected.
 *
 * NOTE ON SCROLLBACK
 * Ink falls back to a full-screen repaint — which erases the terminal's scroll
 * history — whenever a frame is taller than the viewport. The cure is to keep
 * frames inside the viewport, which is what the clipped `ScrollBox` is for; it
 * is NOT to filter escape sequences on the way out. See `scroll-viewport.tsx`.
 */
export function renderSync(node: ReactNode, options?: RenderOptions): Instance {
  return render(node, {
    maxFps: 60,
    incrementalRendering: true,
    ...options,
  });
}
