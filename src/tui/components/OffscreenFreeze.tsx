import { useRef } from 'react';
import { Box } from 'ink';
import type { DOMElement } from 'ink';

interface OffscreenFreezeProps {
  /** When true, returns the cached element snapshot (frozen). */
  frozen: boolean;
  children: React.ReactNode;
  /** Callback ref to attach to the wrapper Box for height measurement. */
  measureRef?: (el: DOMElement | null) => void;
}

/**
 * Freezes children when `frozen` is true by returning the SAME React element
 * reference that was cached during the last visible render.  React's
 * reconciler bails on identical element refs, so the subtree never
 * re-renders, producing zero diff for frozen content.
 *
 * When `frozen` is false, updates the cache and renders live children.
 */
export function OffscreenFreeze({ frozen, children, measureRef }: OffscreenFreezeProps) {
  const cached = useRef(children);

  if (!frozen) {
    cached.current = children;
  }

  return <Box ref={measureRef} flexDirection="column">{cached.current}</Box>;
}
