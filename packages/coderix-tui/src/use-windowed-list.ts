import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { measureElement } from 'ink';
import type { DOMElement } from 'ink';
import type { ScrollBoxHandle } from './scroll-viewport.js';

const MAX_MOUNTED_DEFAULT = 200;
const DEFAULT_ESTIMATE = 3;

export type VirtualScrollOptions = {
  /** Maximum items mounted at once (default 200). */
  maxMounted?: number;
  /** Extra rows beyond the viewport to keep mounted (default 40). */
  overscan?: number;
  /** Height estimate for unmeasured items in rows (default 3). */
  estimateHeight?: number;
};

export type VirtualScrollResult = {
  /** [startIndex, endIndex) half-open slice of items to render. */
  range: readonly [number, number];
  /** Height in rows of the spacer before the first rendered item. */
  topSpacer: number;
  /** Height in rows of the spacer after the last rendered item. */
  bottomSpacer: number;
  /** Callback ref factory. Attach `measureRef(itemKey)` to each item's root Box. */
  measureRef: (key: string) => (el: DOMElement | null) => void;
  /** Ref for the top spacer Box. */
  spacerRef: React.RefObject<DOMElement | null>;
  /** Cumulative y-position of each item in content-wrapper coordinates. */
  offsets: ArrayLike<number>;
  /** Read the computed top offset for the item at index. */
  getItemTop: (index: number) => number;
  /** Get the mounted DOMElement for the item at index, or null. */
  getItemElement: (index: number) => DOMElement | null;
  /** Measured height, or undefined if not yet measured. */
  getItemHeight: (index: number) => number | undefined;
  /** Scroll so item `i` is visible. */
  scrollToIndex: (i: number) => void;
};

/**
 * Bottom-anchored windowed list virtualization.
 *
 * Coderix's transcript always follows the bottom, so we compute the trailing
 * suffix of items that fits the viewport and render only that, with a top
 * spacer holding the remaining height so the window stays bottom-aligned. Item
 * heights are measured with ink's public `measureElement` and cached;
 * unmeasured items fall back to `estimateHeight` until the next measurement
 * pass converges.
 */
export function useVirtualScroll(
  scrollRef: React.RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  _columns: number,
  options?: VirtualScrollOptions,
): VirtualScrollResult {
  const maxMounted = options?.maxMounted ?? MAX_MOUNTED_DEFAULT;
  const estimateHeight = options?.estimateHeight ?? DEFAULT_ESTIMATE;

  const heightsRef = useRef(new Map<string, number>());
  const itemElsRef = useRef(new Map<string, DOMElement>());
  const [measuredTick, setMeasuredTick] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const n = itemKeys.length;

  // Track the viewport height from the parent ScrollBox handle.
  useEffect(() => {
    const handle = scrollRef.current;
    if (!handle) return;
    setViewportHeight(handle.getViewportHeight());
    return handle.subscribe(() => setViewportHeight(handle.getViewportHeight()));
  }, [scrollRef]);

  // Measure mounted items after each commit, deferred until ink's layout pass
  // has run (measureElement reports stale heights if called synchronously in
  // the effect). Cache heights and re-render when any value changes; converges
  // once heights stabilize.
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      if (cancelled) return;
      let changed = false;
      for (const [key, el] of itemElsRef.current) {
        const height = measureElement(el).height;
        if (height > 0 && heightsRef.current.get(key) !== height) {
          heightsRef.current.set(key, height);
          changed = true;
        }
      }
      if (changed) setMeasuredTick((tick) => tick + 1);
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  });

  // Cumulative heights using cached measurements, falling back to the estimate.
  const offsets = useMemo(() => {
    const arr = new Array<number>(n + 1);
    arr[0] = 0;
    for (let i = 0; i < n; i++) {
      arr[i + 1] = arr[i] + (heightsRef.current.get(itemKeys[i]!) ?? estimateHeight);
    }
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKeys, n, measuredTick, estimateHeight]);

  const totalHeight = offsets[n] ?? 0;

  const { range, topSpacer, bottomSpacer } = useMemo(() => {
    if (n === 0) {
      return { range: [0, 0] as const, topSpacer: 0, bottomSpacer: 0 };
    }
    const height = viewportHeight;

    // Cold start (height not measured yet): render everything top-aligned so
    // the viewport can be measured on the next layout pass.
    if (height <= 0) {
      const start = Math.max(0, n - maxMounted);
      return { range: [start, n] as const, topSpacer: 0, bottomSpacer: 0 };
    }

    // Everything fits: render all items from the top.
    if (totalHeight <= height) {
      return { range: [0, n] as const, topSpacer: 0, bottomSpacer: 0 };
    }

    // Tall content: find the trailing suffix that fits within the viewport.
    let start = n;
    let acc = 0;
    while (start > 0) {
      const h = heightsRef.current.get(itemKeys[start - 1]!) ?? estimateHeight;
      if (acc + h > height) break;
      acc += h;
      start -= 1;
    }
    // Always keep at least the last item mounted (e.g. one item taller than the viewport).
    if (start >= n) start = n - 1;
    if (n - start > maxMounted) start = n - maxMounted;

    const windowHeight = offsets[n]! - offsets[start]!;
    const spacer = Math.max(0, height - windowHeight);

    return { range: [start, n] as const, topSpacer: spacer, bottomSpacer: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, viewportHeight, totalHeight, offsets, maxMounted, estimateHeight, itemKeys]);

  const measureRef = useCallback((key: string) => {
    return (el: DOMElement | null) => {
      if (el) itemElsRef.current.set(key, el);
      else itemElsRef.current.delete(key);
    };
  }, []);

  const spacerRef = useRef<DOMElement | null>(null);

  const getItemTop = useCallback((index: number) => offsets[index] ?? 0, [offsets]);
  const getItemElement = useCallback(
    (index: number) => itemElsRef.current.get(itemKeys[index] ?? '') ?? null,
    [itemKeys],
  );
  const getItemHeight = useCallback(
    (index: number) => heightsRef.current.get(itemKeys[index] ?? ''),
    [itemKeys],
  );
  const scrollToIndex = useCallback(
    (i: number) => {
      scrollRef.current?.scrollTo(offsets[i] ?? 0);
    },
    [scrollRef, offsets],
  );

  return {
    range,
    topSpacer,
    bottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  };
}
