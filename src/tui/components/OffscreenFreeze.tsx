import { useRef } from 'react';

interface OffscreenFreezeProps {
  /** When true, returns the cached element snapshot (frozen). */
  frozen: boolean;
  children: React.ReactNode;
  /** Callback ref to attach to the wrapper Box for height measurement. */
  measureRef?: (el: any) => void;
}

/**
 * Freezes children when `frozen` is true by returning the SAME React element
 * reference that was cached during the last visible render.  React's
 * reconciler bails on identical element refs, so the subtree never
 * re-renders, producing zero diff for frozen content.
 *
 * When `frozen` is false, updates the cache and renders live children.
 * No wrapper Box — children render inline to avoid extra Yoga nodes that
 * would cause clear-redraw flicker on every render.
 */
export function OffscreenFreeze({ frozen, children }: OffscreenFreezeProps) {
  const cached = useRef(children);

  if (!frozen) {
    cached.current = children;
  }

  // Return children directly (no Box wrapper) to avoid extra Yoga layout
  // node that causes flicker during streaming re-renders.
  return cached.current;
}
