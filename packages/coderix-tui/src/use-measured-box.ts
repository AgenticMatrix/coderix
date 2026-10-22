import { useEffect, useRef, useState, type RefObject } from 'react';
import type { DOMElement } from 'ink';

export type BoxMetrics = {
  width: number;
  height: number;
  left: number;
  top: number;
  hasMeasured: boolean;
};

const EMPTY: BoxMetrics = { width: 0, height: 0, left: 0, top: 0, hasMeasured: false };

/**
 * Reads a box's laid-out metrics after each render.
 *
 * Deliberately NOT ink's `useBoxMetrics`: that hook subscribes to root layout
 * commits, so every measured box schedules a `setState` from inside
 * `resetAfterCommit`. A transcript mounts hundreds of measured rows at once
 * (and re-mounts them when their keys change); those updates are synchronous
 * and React aborts with "maximum update depth exceeded" (#185) once a metric
 * keeps changing across the cascade.
 *
 * Reading in a passive effect gives the same one-frame-late value `useBoxMetrics`
 * reports, but the update is not enqueued during commit, so a measurement can
 * never chain into another layout pass from inside the current one.
 *
 * The `useEffect` intentionally has no dependency array: layout can change
 * without any prop/state change (siblings appearing, text rewrapping), and the
 * effect itself bails when the numbers are unchanged.
 */
export function useMeasuredBox(ref: RefObject<DOMElement | null>): BoxMetrics {
  const [metrics, setMetrics] = useState<BoxMetrics>(EMPTY);
  const lastRef = useRef<BoxMetrics>(EMPTY);

  useEffect(() => {
    const node = ref.current;
    const layout = node?.yogaNode?.getComputedLayout();
    const next: BoxMetrics = node && layout
      ? {
          width: layout.width,
          height: layout.height,
          left: layout.left,
          top: layout.top,
          hasMeasured: true,
        }
      : EMPTY;

    const prev = lastRef.current;
    if (
      prev.width === next.width &&
      prev.height === next.height &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.hasMeasured === next.hasMeasured
    ) {
      return;
    }

    lastRef.current = next;
    setMetrics(next);
  });

  return metrics;
}
