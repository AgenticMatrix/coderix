/**
 * Shared delta-throttling utility for streaming hooks.
 *
 * Batches APPEND_BLOCK_DELTA dispatches to reduce re-renders
 * during fast streaming so terminal text selection isn't disrupted.
 */
import { useRef, useCallback } from 'react';
import type { ChatAction, BlockDeltaType } from '../../types.js';

/** Throttle interval for batched delta dispatches (ms). */
export const DELTA_FLUSH_INTERVAL = 60;

interface PendingDelta {
  messageId: number;
  deltaType: BlockDeltaType;
  text: string;
}

export function useDeltaThrottle(
  dispatch: React.Dispatch<ChatAction>,
  batchedUpdates?: ((fn: () => void) => void) | null,
) {
  const pendingDeltasRef = useRef<PendingDelta[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushDeltas = useCallback(() => {
    const deltas = pendingDeltasRef.current;
    pendingDeltasRef.current = [];
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const apply = () => {
      for (const d of deltas) {
        dispatch({ type: 'APPEND_BLOCK_DELTA', messageId: d.messageId, deltaType: d.deltaType, text: d.text });
      }
    };
    if (batchedUpdates) {
      batchedUpdates(apply);
    } else {
      apply();
    }
  }, [dispatch, batchedUpdates]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = setTimeout(flushDeltas, DELTA_FLUSH_INTERVAL);
  }, [flushDeltas]);

  return { pendingDeltasRef, flushDeltas, scheduleFlush } as const;
}
