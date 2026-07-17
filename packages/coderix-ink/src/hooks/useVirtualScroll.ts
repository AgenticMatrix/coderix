import type { RefObject } from 'react';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useEffect,
} from 'react';
import type { DOMElement } from '../core/dom.js';
import type { ScrollBoxHandle } from '../components/ScrollBox.js';

// ── Tunables ──────────────────────────────────────────────────────────

/** Assumed row-height for items not yet measured. Low estimate avoids blank
 *  space; real Yoga heights replace it on the next layout pass. */
const DEFAULT_ESTIMATE = 3;

/** Extra rows rendered above and below the visible viewport. */
const DEFAULT_OVERSCAN = 40;

/** Items rendered before the ScrollBox has laid out (viewportHeight = 0). */
const COLD_START_ITEMS = 30;

/** Worst-case height for unmeasured items during coverage extension. Using 1
 *  guarantees the mounted range physically covers the viewport regardless of
 *  how small items actually are - over-mounts when items are tall, which is
 *  fine (overscan absorbs the extra). */
const MIN_HEIGHT = 1;

/** Hard cap on simultaneously mounted items to bound fiber allocation. */
const MAX_MOUNTED_DEFAULT = 200;

/** Max NEW items to mount in a single commit during fast scroll. Prevents
 *  multi-hundred-millisecond sync render blocks when the user jumps far. */
const SLIDE_CAP = 25;

// ── Hook ──────────────────────────────────────────────────────────────

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
  /** Height in rows of spacer before the first rendered item. */
  topSpacer: number;
  /** Height in rows of spacer after the last rendered item. */
  bottomSpacer: number;
  /**
   * Callback ref factory. Attach `measureRef(itemKey)` to each rendered
   * item's root Box; after Yoga layout the computed height is cached.
   */
  measureRef: (key: string) => (el: DOMElement | null) => void;
  /**
   * Attach to the topSpacer Box. Its Yoga computedTop equals listOrigin
   * (cumulative height of everything rendered before the virtualized
   * region in the ScrollBox), used as a drift-free coordinate anchor.
   */
  spacerRef: RefObject<DOMElement | null>;
  /** Cumulative y-position of each item in content-wrapper coordinates. */
  offsets: ArrayLike<number>;
  /**
   * Read Yoga computedTop for the item at index. Returns -1 if the item
   * is not currently mounted or has not been laid out yet.
   */
  getItemTop: (index: number) => number;
  /** Get the mounted DOMElement for the item at index, or null. */
  getItemElement: (index: number) => DOMElement | null;
  /** Measured Yoga height, or undefined if not yet measured. */
  getItemHeight: (index: number) => number | undefined;
  /**
   * Scroll so item `i` is in the mounted range. Sets scrollTop to
   * offsets[i] + listOrigin so the item is guaranteed to mount.
   */
  scrollToIndex: (i: number) => void;
};

/**
 * React-level virtual scrolling for items inside a ScrollBox.
 *
 * The ScrollBox already culls terminal output for off-screen children
 * (render-node-to-output.ts skips items outside the visible window), but
 * all React fibers + Yoga nodes are still allocated. Over a long session
 * this grows to hundreds of megabytes.
 *
 * This hook mounts only items within viewport + overscan. Spacer boxes
 * hold the scroll height constant for the rest at O(1) fiber cost each.
 *
 * Usage:
 * ```tsx
 * const { range, topSpacer, bottomSpacer, measureRef } = useVirtualScroll(
 *   scrollRef, itemKeys, columns
 * );
 * return (
 *   <>
 *     <Box height={topSpacer} />
 *     {items.slice(...range).map((item, i) => (
 *       <Box key={keys[start + i]} ref={measureRef(keys[start + i])}>
 *         {renderItem(item)}
 *       </Box>
 *     ))}
 *     <Box height={bottomSpacer} />
 *   </>
 * );
 * ```
 */
export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  columns: number,
  options?: VirtualScrollOptions,
): VirtualScrollResult {
  const maxMounted = options?.maxMounted ?? MAX_MOUNTED_DEFAULT;
  const overscan = options?.overscan ?? DEFAULT_OVERSCAN;
  const estimatedRowHeight = options?.estimateHeight ?? DEFAULT_ESTIMATE;

  // ── Mutable caches (refs, not state — no extra commits) ──────────

  const heightCache = useRef(new Map<string, number>());
  const cacheGeneration = useRef(0);
  const itemRefs = useRef(new Map<string, DOMElement>());
  const refFactoryCache = useRef(new Map<string, (el: DOMElement | null) => void>());
  const spacerRef = useRef<DOMElement | null>(null);
  const listOriginRef = useRef(0);
  const prevRange = useRef<readonly [number, number] | null>(null);
  const lastScrollSnapshot = useRef(0);

  // Offsets cached across renders for O(1) access. Float64Array avoids
  // per-render array allocations. Rebuilt when the cache version bumps.
  const offsetsBuf = useRef(new Float64Array(0));
  const offsetsVersion = useRef(-1);
  const offsetsLen = useRef(-1);

  // Column-width tracking for height-cache scaling on resize.
  const prevColumns = useRef(columns);
  const skipMeasure = useRef(false);
  const freezeCount = useRef(0);

  // ── Column-resize: scale cached heights instead of clearing ──────

  if (prevColumns.current !== columns) {
    const ratio = prevColumns.current / columns;
    prevColumns.current = columns;
    const cache = heightCache.current;
    for (const [k, h] of cache) {
      cache.set(k, Math.max(1, Math.round(h * ratio)));
    }
    cacheGeneration.current++;
    skipMeasure.current = true;
    freezeCount.current = 2;
  }
  const isFrozen = freezeCount.current > 0;
  const frozenRange = isFrozen ? prevRange.current : null;

  // ── Scroll subscription (state-driven, avoids useSyncExternalStore) ─
  // useSyncExternalStore can trigger renderWithHooksAgain in React 19's
  // custom reconciler when getSnapshot detects store changes during render.
  // The Rerender dispatcher (HooksDispatcherOnRerenderInDEV) may not properly
  // advance the hook chain, causing "Rendered fewer hooks than expected".
  // useState + useEffect avoids this path entirely while keeping the same
  // hook count (2 hooks replace useCallback(subscribe) + useSyncExternalStore).

  const [, setScrollTick] = useState(0);

  useEffect(() => {
    const s = scrollRef.current;
    if (!s) return;
    return s.subscribe(() => setScrollTick((t) => t + 1));
  }, [scrollRef]);

  const scrollTop = scrollRef.current?.getScrollTop() ?? -1;
  const pendingDelta = scrollRef.current?.getPendingDelta() ?? 0;
  const viewportH = scrollRef.current?.getViewportHeight() ?? 0;
  const isSticky = scrollRef.current?.isSticky() ?? true;

  // ── GC stale cache entries when itemKeys change ──────────────────

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => {
    const live = new Set(itemKeys);
    let dirty = false;
    for (const k of heightCache.current.keys()) {
      if (!live.has(k)) {
        heightCache.current.delete(k);
        dirty = true;
      }
    }
    for (const k of refFactoryCache.current.keys()) {
      if (!live.has(k)) refFactoryCache.current.delete(k);
    }
    if (dirty) cacheGeneration.current++;
  }, [itemKeys]);

  // ── Build offsets prefix sum ─────────────────────────────────────

  const n = itemKeys.length;
  if (offsetsVersion.current !== cacheGeneration.current || offsetsLen.current !== n) {
    let arr = offsetsBuf.current;
    if (arr.length < n + 1) arr = new Float64Array(n + 1);
    arr[0] = 0;
    const cache = heightCache.current;
    for (let i = 0; i < n; i++) {
      arr[i + 1] = arr[i]! + (cache.get(itemKeys[i]!) ?? estimatedRowHeight);
    }
    offsetsBuf.current = arr;
    offsetsVersion.current = cacheGeneration.current;
    offsetsLen.current = n;
  }
  const offsets = offsetsBuf.current;
  const totalHeight = offsets[n]!;

  // ── Compute mount range ──────────────────────────────────────────

  let start: number;
  let end: number;

  if (frozenRange) {
    // Column just changed — lock to pre-resize range to avoid mount churn.
    [start, end] = frozenRange;
    start = Math.min(start, n);
    end = Math.min(end, n);
  } else if (viewportH === 0 || scrollTop < 0) {
    // Cold start: ScrollBox hasn't laid out yet. Render the tail since
    // sticky scroll pins to bottom on the first frame.
    start = Math.max(0, n - COLD_START_ITEMS);
    end = n;
  } else if (isSticky) {
    // Pinned to bottom: walk backwards from the tail until the viewport
    // plus overscan is covered by cumulative estimated height.
    const budget = viewportH + overscan;
    start = n;
    while (start > 0 && totalHeight - offsets[start - 1]! < budget) {
      start--;
    }
    end = n;
  } else {
    // Free-scrolling: compute start from the effective scroll position.
    // The effective scroll window extends from committed scrollTop to
    // committed + pendingDelta, ensuring intermediate drain frames also
    // have mounted children.
    const listOrigin = listOriginRef.current;
    const maxSpan = viewportH * 3;
    const rawLo = Math.min(scrollTop, scrollTop + pendingDelta);
    const rawHi = Math.max(scrollTop, scrollTop + pendingDelta);
    const span = rawHi - rawLo;
    const effLo =
      span > maxSpan
        ? pendingDelta < 0
          ? rawHi - maxSpan
          : rawLo
        : rawLo;
    const effHi = effLo + Math.min(span, maxSpan);
    const lo = Math.max(0, effLo - listOrigin - overscan);

    // Binary search for the start index.
    {
      let l = 0;
      let r = n;
      while (l < r) {
        const m = (l + r) >> 1;
        if (offsets[m + 1]! <= lo) l = m + 1;
        else r = m;
      }
      start = l;
    }

    // Extend end by REAL measured heights (not estimates). For unmeasured
    // items, assume MIN_HEIGHT = 1 — the smallest possible row count. This
    // over-mounts when items are tall but NEVER leaves blank viewport.
    const needed = viewportH + 2 * overscan;
    const maxEnd = Math.min(n, start + maxMounted);
    let coverage = 0;
    end = start;
    const cache = heightCache.current;
    const hiTarget = effHi - listOrigin + viewportH + overscan;
    while (
      end < maxEnd &&
      (coverage < needed || offsets[end]! < hiTarget)
    ) {
      coverage += cache.get(itemKeys[end]!) ?? MIN_HEIGHT;
      end++;
    }

    // Same coverage guarantee for the start side: walk backwards if needed.
    const minStart = Math.max(0, end - maxMounted);
    coverage = 0;
    for (let i = start; i < end; i++) {
      coverage += cache.get(itemKeys[i]!) ?? MIN_HEIGHT;
    }
    while (start > minStart && coverage < needed) {
      start--;
      coverage += cache.get(itemKeys[start]!) ?? MIN_HEIGHT;
    }

    // ── Slide cap: limit new mounts per commit during fast scroll ──
    const scrollVel =
      Math.abs(scrollTop - lastScrollSnapshot.current) + Math.abs(pendingDelta);
    const prev = prevRange.current;
    if (prev && scrollVel > viewportH * 2) {
      const [pS, pE] = prev;
      if (start < pS - SLIDE_CAP) start = pS - SLIDE_CAP;
      if (end > pE + SLIDE_CAP) end = pE + SLIDE_CAP;
      if (start > end) end = Math.min(start + SLIDE_CAP, n);
    }
    lastScrollSnapshot.current = scrollTop;
  }

  // ── Freeze bookkeeping ───────────────────────────────────────────

  if (freezeCount.current > 0) {
    freezeCount.current--;
  } else {
    prevRange.current = [start, end];
  }

  // ── Effective range (use raw start/end — useDeferredValue is incompatible
  //    with the ink reconciler's synchronous render pipeline) ────────────

  let effStart = start;
  let effEnd = end;

  // ── Final O(viewport) enforcement ────────────────────────────────

  if (effEnd - effStart > maxMounted) {
    const mid = (offsets[effStart]! + offsets[effEnd]!) / 2;
    if (scrollTop - listOriginRef.current < mid) {
      effEnd = effStart + maxMounted;
    } else {
      effStart = effEnd - maxMounted;
    }
  }

  // ── Set clamp bounds (prevents scroll past mounted range) ───────

  const listOrigin = listOriginRef.current;
  const effTopSpacer = offsets[effStart]!;
  const clampMin = effStart === 0 ? 0 : effTopSpacer + listOrigin;
  const clampMax =
    effEnd === n
      ? Infinity
      : Math.max(effTopSpacer, offsets[effEnd]! - viewportH) + listOrigin;

  useLayoutEffect(() => {
    if (isSticky) {
      scrollRef.current?.setClampBounds(undefined, undefined);
    } else {
      scrollRef.current?.setClampBounds(clampMin, clampMax);
    }
  });

  // ── Height measurement (runs every commit — Yoga updates outside React) ──

  useLayoutEffect(() => {
    const sy = spacerRef.current?.yogaNode;
    if (sy && sy.getComputedWidth() > 0) {
      listOriginRef.current = sy.getComputedTop();
    }
    if (skipMeasure.current) {
      skipMeasure.current = false;
      return;
    }
    let changed = false;
    const cache = heightCache.current;
    for (const [key, el] of itemRefs.current) {
      const yoga = el.yogaNode;
      if (!yoga) continue;
      const h = yoga.getComputedHeight();
      const prev = cache.get(key);
      if (h > 0) {
        if (prev !== h) {
          cache.set(key, h);
          changed = true;
        }
      } else if (yoga.getComputedWidth() > 0 && prev !== 0) {
        // h=0 AND Yoga has laid out (width>0) → genuinely empty item.
        cache.set(key, 0);
        changed = true;
      }
    }
    if (changed) cacheGeneration.current++;
  });

  // ── Stable per-key callback refs ─────────────────────────────────

  const measureRef = useCallback((key: string) => {
    let fn = refFactoryCache.current.get(key);
    if (!fn) {
      fn = (el: DOMElement | null) => {
        if (el) {
          itemRefs.current.set(key, el);
        } else {
          // Capture last-known height at unmount while yogaNode is still live.
          const yoga = itemRefs.current.get(key)?.yogaNode;
          if (yoga && !skipMeasure.current) {
            const h = yoga.getComputedHeight();
            if ((h > 0 || yoga.getComputedWidth() > 0) && heightCache.current.get(key) !== h) {
              heightCache.current.set(key, h);
              cacheGeneration.current++;
            }
          }
          itemRefs.current.delete(key);
        }
      };
      refFactoryCache.current.set(key, fn);
    }
    return fn;
  }, []);

  // ── Utility accessors ────────────────────────────────────────────

  const getItemTop = useCallback(
    (index: number) => {
      const yoga = itemRefs.current.get(itemKeys[index]!)?.yogaNode;
      if (!yoga || yoga.getComputedWidth() === 0) return -1;
      return yoga.getComputedTop();
    },
    [itemKeys],
  );

  const getItemElement = useCallback(
    (index: number) => itemRefs.current.get(itemKeys[index]!) ?? null,
    [itemKeys],
  );

  const getItemHeight = useCallback(
    (index: number) => heightCache.current.get(itemKeys[index]!),
    [itemKeys],
  );

  const scrollToIndex = useCallback(
    (i: number) => {
      const o = offsetsBuf.current;
      if (i < 0 || i >= offsetsLen.current) return;
      scrollRef.current?.scrollTo(o[i]! + listOriginRef.current);
    },
    [scrollRef],
  );

  const effBottomSpacer = totalHeight - offsets[effEnd]!;

  return {
    range: [effStart, effEnd],
    topSpacer: effTopSpacer,
    bottomSpacer: effBottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  };
}
