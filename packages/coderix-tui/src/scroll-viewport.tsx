import React, { useEffect, useImperativeHandle, useRef } from 'react';
import { Box, useBoxMetrics } from 'ink';
import type { DOMElement } from 'ink';
import type { BoxProps } from 'ink';

export type ScrollBoxHandle = {
  scrollTo: (y: number) => void;
  scrollBy: (dy: number) => void;
  scrollToElement: (el: DOMElement, offset?: number) => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  getViewportHeight: () => number;
  getScrollHeight: () => number;
  isSticky: () => boolean;
  subscribe: (listener: () => void) => () => void;
  setClampBounds: (min: number | undefined, max: number | undefined) => void;
};

export type ScrollBoxProps = Omit<BoxProps, 'overflow' | 'overflowX' | 'overflowY' | 'children'> & {
  ref?: React.Ref<ScrollBoxHandle>;
  /** When true, scroll stays pinned to the bottom as content grows. */
  stickyScroll?: boolean;
  children?: React.ReactNode;
};

/**
 * A bottom-anchored scrollable viewport.
 *
 * This is a simplified, clean-room replacement for the previous ink-fork
 * ScrollBox. It renders children in an `overflow: hidden` box and delegates
 * windowing to `useVirtualScroll`, which renders only the visible suffix plus
 * a top spacer. Because Coderix's UI always follows the bottom (no manual
 * scroll is wired up), a full bidirectional scroll engine is unnecessary; the
 * handle below still exposes scroll methods for API compatibility.
 */
function ScrollBox({ children, ref, stickyScroll, ...style }: ScrollBoxProps): React.ReactNode {
  const boxRef = useRef<DOMElement | null>(null);
  const { height: viewportHeight } = useBoxMetrics(boxRef);

  const viewportHeightRef = useRef(0);
  viewportHeightRef.current = viewportHeight;

  const scrollTopRef = useRef(0);
  const stickyRef = useRef(stickyScroll ?? true);
  const listenersRef = useRef(new Set<() => void>());

  const notify = () => {
    for (const listener of listenersRef.current) listener();
  };

  // Re-measure subscribers when the viewport height changes after layout.
  useEffect(() => {
    notify();
  }, [viewportHeight]);

  useImperativeHandle(
    ref,
    (): ScrollBoxHandle => ({
      scrollTo(y: number) {
        scrollTopRef.current = Math.max(0, Math.floor(y));
        stickyRef.current = false;
        notify();
      },
      scrollBy(dy: number) {
        scrollTopRef.current = Math.max(0, scrollTopRef.current + Math.floor(dy));
        stickyRef.current = false;
        notify();
      },
      scrollToElement(_el: DOMElement, _offset = 0) {
        // Not supported by the simplified engine; the app never calls this.
      },
      scrollToBottom() {
        stickyRef.current = true;
        notify();
      },
      getScrollTop() {
        return scrollTopRef.current;
      },
      getViewportHeight() {
        return viewportHeightRef.current;
      },
      getScrollHeight() {
        return viewportHeightRef.current;
      },
      isSticky() {
        return stickyRef.current;
      },
      subscribe(listener: () => void) {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      setClampBounds(_min: number | undefined, _max: number | undefined) {
        // Not supported by the simplified engine.
      },
    }),
    [],
  );

  return (
    <Box ref={boxRef} flexDirection="column" {...style}>
      <Box flexDirection="column" flexGrow={1} flexShrink={0} width="100%">
        {children}
      </Box>
    </Box>
  );
}

export default ScrollBox;
