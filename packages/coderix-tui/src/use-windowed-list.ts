import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Box, useBoxMetrics } from 'ink';
import type { DOMElement } from 'ink';
import type { ScrollBoxHandle } from './scroll-viewport.js';

const DEFAULT_MAX_MOUNTED = 200;
const DEFAULT_OVERSCAN = 20;
const DEFAULT_ESTIMATE = 3;

export type VirtualScrollOptions = {
  /** Upper bound on simultaneously mounted items (default 200). */
  maxMounted?: number;
  /** Extra rows rendered above and below the viewport (default 20). */
  overscan?: number;
  /** Row height assumed for items that have never been measured (default 3). */
  estimateHeight?: number;
};

export type VirtualScrollResult = {
  /** Half-open `[start, end)` slice of items to mount. */
  range: readonly [number, number];
  /** Rows of filler standing in for the unmounted items above `start`. */
  topSpacer: number;
  /** Rows of filler standing in for the unmounted items below `end`. */
  bottomSpacer: number;
  /** Reports an item's measured height. Stable identity. */
  onMeasure: (key: string, height: number) => void;
  /** Attach to the top spacer box (kept for API compatibility). */
  spacerRef: RefObject<DOMElement | null>;
  /** Total height of all items: measured where known, estimated elsewhere. */
  totalHeight: number;
  /** Scroll so the item at `index` is brought into view. */
  scrollToIndex: (index: number) => void;
};

/**
 * Wraps one list item and reports its height as laid out by Yoga.
 *
 * `useBoxMetrics` tracks the live layout, so a height change (text rewrapping
 * after a resize, a streaming message growing) is reported without polling.
 */
export function MeasuredItem({
  itemKey,
  onMeasure,
  children,
}: {
  itemKey: string;
  onMeasure: (key: string, height: number) => void;
  children?: ReactNode;
}): ReactNode {
  const ref = useRef<DOMElement | null>(null);
  const { height, hasMeasured } = useBoxMetrics(ref);

  useEffect(() => {
    if (hasMeasured) onMeasure(itemKey, height);
  }, [itemKey, height, hasMeasured, onMeasure]);

  return createElement(Box, { ref, flexDirection: 'column', flexShrink: 0 }, children);
}

/**
 * Windowed rendering for a long list inside a clipping `ScrollBox`.
 *
 * Only the items overlapping the visible window (plus `overscan` rows of
 * margin) are mounted; the rest are replaced by two spacer boxes whose heights
 * add up to the space those items would have occupied. Total content height is
 * therefore unchanged, which keeps the parent viewport's scroll arithmetic
 * honest.
 *
 * The window is derived from the viewport's real scroll offset, read from the
 * `ScrollBox` handle — not guessed. Heights are measured by `MeasuredItem` and
 * cached; anything not yet measured contributes `estimateHeight`, and the
 * window is recomputed as real measurements arrive.
 */
export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  _columns: number,
  options?: VirtualScrollOptions,
): VirtualScrollResult {
  const maxMounted = options?.maxMounted ?? DEFAULT_MAX_MOUNTED;
  const overscan = options?.overscan ?? DEFAULT_OVERSCAN;
  const estimateHeight = options?.estimateHeight ?? DEFAULT_ESTIMATE;

  const heights = useRef(new Map<string, number>());
  const [measureTick, setMeasureTick] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  const count = itemKeys.length;

  // Track the parent viewport's scroll offset and height.
  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) return;

    const read = () => {
      const top = handle.getScrollTop();
      const height = handle.getViewportHeight();
      setViewport((prev) => (prev.top === top && prev.height === height ? prev : { top, height }));
    };

    read();
    return handle.subscribe(read);
  }, [scrollRef]);

  const onMeasure = useCallback((key: string, height: number) => {
    if (height <= 0) return;
    if (heights.current.get(key) === height) return;
    heights.current.set(key, height);
    setMeasureTick((tick) => tick + 1);
  }, []);

  // Drop cached heights for items that no longer exist, so the map does not
  // grow without bound across compaction and /clear.
  useEffect(() => {
    if (heights.current.size <= itemKeys.length * 2) return;
    const live = new Set(itemKeys);
    for (const key of heights.current.keys()) {
      if (!live.has(key)) heights.current.delete(key);
    }
  }, [itemKeys]);

  /** Prefix sums: `offsets[i]` is the y position of item `i`. */
  const offsets = useMemo(() => {
    const sums = new Array<number>(count + 1);
    sums[0] = 0;
    for (let i = 0; i < count; i++) {
      sums[i + 1] = sums[i]! + (heights.current.get(itemKeys[i]!) ?? estimateHeight);
    }
    return sums;
    // `measureTick` intentionally invalidates this when a height is learned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKeys, count, measureTick, estimateHeight]);

  const totalHeight = offsets[count] ?? 0;

  const { range, topSpacer, bottomSpacer } = useMemo(() => {
    if (count === 0) {
      return { range: [0, 0] as const, topSpacer: 0, bottomSpacer: 0 };
    }

    // Before the first layout pass the viewport height is unknown. Mount the
    // most recent items so the next pass has something to measure.
    if (viewport.height <= 0) {
      return {
        range: [Math.max(0, count - maxMounted), count] as const,
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }

    const windowTop = viewport.top - overscan;
    const windowBottom = viewport.top + viewport.height + overscan;

    // Last item starting at or before the window's top edge.
    let start = lastIndexAtOrBefore(offsets, windowTop, count);
    // Advance past every item that begins before the window's bottom edge.
    let end = start;
    while (end < count && offsets[end]! < windowBottom) end += 1;
    if (end === start && start < count) end = start + 1;

    // Cap the mounted count, keeping the window anchored near the viewport.
    if (end - start > maxMounted) start = Math.max(0, end - maxMounted);

    return {
      range: [start, end] as const,
      topSpacer: offsets[start] ?? 0,
      bottomSpacer: Math.max(0, (offsets[count] ?? 0) - (offsets[end] ?? 0)),
    };
  }, [count, viewport, offsets, overscan, maxMounted]);

  const spacerRef = useRef<DOMElement | null>(null);

  const scrollToIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, Math.max(0, count - 1)));
      scrollRef.current?.scrollTo(offsets[clamped] ?? 0);
    },
    [scrollRef, offsets, count],
  );

  return { range, topSpacer, bottomSpacer, onMeasure, spacerRef, totalHeight, scrollToIndex };
}

/**
 * Index of the last entry in the ascending prefix-sum array whose value is at
 * or below `target`, clamped into `[0, count)`.
 */
function lastIndexAtOrBefore(offsets: readonly number[], target: number, count: number): number {
  if (target <= 0) return 0;
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid]! <= target) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}
