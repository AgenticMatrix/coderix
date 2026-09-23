import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Box, useBoxMetrics } from 'ink';
import type { BoxProps, DOMElement } from 'ink';

/**
 * Imperative scroll API exposed via `ref`.
 */
export type ScrollBoxHandle = {
  scrollTo: (y: number) => void;
  scrollBy: (dy: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  getViewportHeight: () => number;
  getContentHeight: () => number;
  /** True while the view is pinned to the bottom and follows new content. */
  isSticky: () => boolean;
  /** Notifies listeners whenever scroll position or measured sizes change. */
  subscribe: (listener: () => void) => () => void;
};

export type ScrollBoxProps = Omit<
  BoxProps,
  'overflow' | 'overflowX' | 'overflowY' | 'height' | 'children'
> & {
  ref?: React.Ref<ScrollBoxHandle>;
  /**
   * Viewport height in rows. **Required for clipping to work.**
   *
   * Ink only clips a box whose height is explicitly set — a `flexGrow` box is
   * stretched by its own children, so the frame ends up taller than the
   * terminal no matter what `overflow` says. See the note below on why that
   * matters.
   */
  height: number;
  /** Follow the bottom as content grows (default true). */
  stickyScroll?: boolean;
  /**
   * Treat `height` as a ceiling rather than a fixed size: when the content is
   * shorter, the viewport shrinks to it.
   *
   * Without this a short transcript is padded out to the full `height`, which
   * pushes the content to the top of the screen and leaves the gap between it
   * and whatever sits below (the input, the status bar) as dead space. The
   * clipping guarantee is unaffected — it only ever engages when the content is
   * TALLER than `height`, and in that case the height is unchanged.
   */
  shrinkToContent?: boolean;
  /**
   * Receives the inner content box, so a caller can read the content's natural
   * height with `useBoxMetrics` — the height the content WANTS, before clipping.
   * `getContentHeight()` on the handle reports the same number, but only
   * imperatively; this makes it available during render.
   */
  contentRef?: React.Ref<DOMElement | null>;
  children?: React.ReactNode;
};

/**
 * A scrollable viewport that genuinely clips its content.
 *
 * Structure:
 *
 *   outer  height=<viewport>, overflow=hidden   <- the clipping window
 *     └── inner  marginTop=-scrollTop           <- full-height content, shifted
 *
 * The inner box is laid out at its natural (full) height and pulled upwards by
 * a negative margin; the outer box clips whatever falls outside. Scrolling is
 * therefore just a change of that offset, which keeps the rendered frame
 * exactly `height` rows tall regardless of how long the transcript grows.
 *
 * WHY THE EXPLICIT HEIGHT MATTERS
 * Ink decides to repaint the whole screen (`ansiEscapes.clearTerminal`, which
 * includes `ESC[3J` — *erase scrollback*) whenever a frame overflows the
 * viewport. A viewport built from `flexGrow` does not constrain its children,
 * so once the transcript passes one screen every frame overflows, Ink clears on
 * every frame, and the terminal's scroll history is destroyed continuously —
 * the user cannot scroll back at all. Clipping to a known height keeps every
 * frame within the viewport, so that repaint path is never taken and scrollback
 * survives. This is measured behaviour, not a guess: with clipping, `ESC[3J` is
 * emitted zero times across arbitrary content growth.
 */
function ScrollBox({
  children,
  ref,
  height,
  stickyScroll = true,
  shrinkToContent = false,
  contentRef: externalContentRef,
  ...style
}: ScrollBoxProps): React.ReactNode {
  const contentRef = useRef<DOMElement | null>(null);
  const { height: contentHeight } = useBoxMetrics(contentRef);

  // Forward the content node to the caller's ref as well, so both this
  // component and the caller can measure it.
  const attachContent = useCallback(
    (node: DOMElement | null) => {
      contentRef.current = node;
      if (typeof externalContentRef === 'function') externalContentRef(node);
      else if (externalContentRef) {
        (externalContentRef as React.RefObject<DOMElement | null>).current = node;
      }
    },
    [externalContentRef],
  );

  const [scrollTop, setScrollTop] = useState(0);
  const stickyRef = useRef(stickyScroll);

  // Mirror reactive values into refs so the imperative handle can read the
  // latest values without being re-created on every change.
  const scrollTopRef = useRef(0);
  scrollTopRef.current = scrollTop;
  const contentRef2 = useRef(0);
  contentRef2.current = contentHeight;

  const listeners = useRef(new Set<() => void>());
  const notify = useCallback(() => {
    for (const listener of listeners.current) listener();
  }, []);

  // The rendered viewport. Shrinking to the content is purely cosmetic — it
  // removes the dead space below a short transcript — and cannot weaken the
  // clipping, which only matters when the content is taller than `height`.
  //
  // `contentHeight` is 0 until the first layout pass reports it; falling back to
  // `height` for that frame avoids collapsing the viewport to nothing before
  // there is anything to measure.
  const viewportHeight =
    shrinkToContent && contentHeight > 0 ? Math.min(height, contentHeight) : height;

  // The imperative handle reports the height that is actually on screen, so
  // `scrollBy(getViewportHeight())` pages by what the user can see.
  const viewportRef = useRef(viewportHeight);
  viewportRef.current = viewportHeight;

  const maxScroll = Math.max(0, contentHeight - viewportHeight);

  const clamp = useCallback((y: number, limit: number) => {
    if (!Number.isFinite(y)) return 0;
    return Math.max(0, Math.min(Math.floor(y), limit));
  }, []);

  // Follow the bottom as content grows, and never leave a gap below the
  // content after it shrinks or the terminal is resized.
  useEffect(() => {
    setScrollTop((current) => {
      const next = stickyRef.current ? maxScroll : Math.min(current, maxScroll);
      return next === current ? current : next;
    });
  }, [maxScroll]);

  useEffect(() => {
    notify();
  }, [scrollTop, viewportHeight, contentHeight, notify]);

  useImperativeHandle(
    ref,
    (): ScrollBoxHandle => ({
      scrollTo(y) {
        const limit = Math.max(0, contentRef2.current - viewportRef.current);
        const next = clamp(y, limit);
        stickyRef.current = next >= limit;
        setScrollTop(next);
      },
      scrollBy(dy) {
        const limit = Math.max(0, contentRef2.current - viewportRef.current);
        const next = clamp(scrollTopRef.current + dy, limit);
        stickyRef.current = next >= limit;
        setScrollTop(next);
      },
      scrollToTop() {
        stickyRef.current = false;
        setScrollTop(0);
      },
      scrollToBottom() {
        stickyRef.current = true;
        setScrollTop(Math.max(0, contentRef2.current - viewportRef.current));
      },
      getScrollTop: () => scrollTopRef.current,
      getViewportHeight: () => viewportRef.current,
      getContentHeight: () => contentRef2.current,
      isSticky: () => stickyRef.current,
      subscribe(listener) {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [clamp],
  );

  return (
    <Box {...style} height={viewportHeight} flexDirection="column" overflow="hidden">
      <Box
        ref={attachContent}
        flexDirection="column"
        flexShrink={0}
        width="100%"
        marginTop={-scrollTop}
      >
        {children}
      </Box>
    </Box>
  );
}

export default ScrollBox;
