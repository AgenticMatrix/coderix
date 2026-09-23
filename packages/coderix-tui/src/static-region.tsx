import React from 'react';
import { Static as InkStatic } from 'ink';
import type { ReactNode } from 'react';
import type { BoxProps } from 'ink';

/**
 * An append-only output region: its children are written to the terminal once
 * and never repainted.
 *
 * WHY THIS IS THE ONLY WAY TO GET A SCROLLABLE TRANSCRIPT
 * Scrolling belongs to the terminal, not to us — the wheel, the trackpad, the
 * scrollbar, Cmd+F and copy-paste all act on the terminal's own scrollback
 * buffer. So history is reachable only if both of these hold:
 *
 *   1. rows actually ENTER scrollback, and
 *   2. scrollback is never ERASED.
 *
 * A clipped viewport satisfies (2) and breaks (1): nothing ever leaves the
 * viewport, so the wheel has nothing to scroll. Letting the frame grow past the
 * viewport satisfies (1) and breaks (2), because ink repaints the whole screen —
 * `ESC[3J`, erase scrollback — for any frame that fills it.
 *
 * Rows placed here escape that trade-off. Ink writes them out once and, when it
 * measures the frame against the terminal height, it excludes them. History can
 * therefore grow without bound while the repainted frame stays short enough that
 * ink's erase path is never reached.
 *
 * TWO RULES FOR CALLERS
 *   - Hand over only finished content. A committed row cannot be edited; a
 *     later correction is printed BELOW the stale copy, not over it.
 *   - `items` must only ever grow at the end. The region remembers how many
 *     items it has emitted and renders the remainder, so a removal or a reorder
 *     silently drops or duplicates rows. To reprint history in a new form,
 *     change the `key` instead: that mounts a fresh region, which ink treats as
 *     "discard what was accumulated and emit everything again".
 */
export type StaticProps<T> = {
  /**
   * The committed items, oldest first. Declared `readonly` because this region
   * never mutates the array — which lets callers derive it with `slice` without
   * having to launder the type.
   */
  readonly items: readonly T[];
  /** Styles for the container holding the emitted children. */
  readonly style?: BoxProps;
  /**
   * Renders one item. Called only for items not yet emitted. The returned
   * element needs its own `key`.
   */
  readonly children: (item: T, index: number) => ReactNode;
};

export function Static<T>({ items, style, children }: StaticProps<T>): React.ReactNode {
  return React.createElement(
    InkStatic as unknown as React.ComponentType<{
      items: readonly T[];
      style?: BoxProps;
      children: (item: T, index: number) => ReactNode;
    }>,
    { items, style, children },
  );
}

export default Static;
