/**
 * Shared delta-throttling utility for streaming hooks.
 *
 * Accumulates text deltas and dispatches only complete lines (split at \n).
 * Same-line characters never trigger reducer dispatches — only a newline or
 * an explicit force-flush (block transition, stream end) will deliver text.
 *
 * Non-text deltas (thinking, json/tool_use) are dispatched immediately.
 * A 60 ms fallback timer re-checks the accumulator in case a newline arrived
 * without new deltas (unlikely but safe).
 */
import { useRef, useCallback } from 'react';
import type { ChatAction, BlockDeltaType } from '../../types.js';

/** Normal flush interval for batched delta dispatches (ms). */
export const DELTA_FLUSH_INTERVAL = 60;

/** Maximum stored length for tool result content. Results exceeding this
 *  are truncated before entering TUI state to bound per-message memory.
 *  100 KB is enough for inline diffs, code display, and command output
 *  without letting a single large file read blow up the heap. */
export const MAX_RESULT_LENGTH = 100_000;

/** Truncate long tool result content to MAX_RESULT_LENGTH by keeping the
 *  first and last HALF_CAP characters, with an omission notice in between.
 *  This preserves both the header/context (front) and the tail/errors (back)
 *  of large outputs like build logs and stack traces. */
export function truncateResult(content: string): string {
  if (!content || content.length <= MAX_RESULT_LENGTH) return content || '';
  const omitted = content.length - MAX_RESULT_LENGTH;
  const kb = Math.round(omitted / 1024);
  const half = Math.floor(MAX_RESULT_LENGTH / 2);
  const head = content.slice(0, half);
  const tail = content.slice(-half);
  return `${head}\n\n[...truncated ${kb} KB in middle]\n\n${tail}`;
}

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
  /** messageId → accumulated text that hasn't been dispatched yet. */
  const textAccumRef = useRef<Map<number, string>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  /**
   * Flush accumulated deltas to the reducer.
   *
   * @param force — When true, flush ALL remaining text (including incomplete
   *   lines). Used before STOP_BLOCK, START_BLOCK, message_stop, done, and
   *   error to ensure no text is lost during block transitions.
   */
  const flushDeltas = useCallback(
    (force = false) => {
      const deltas = pendingDeltasRef.current;
      pendingDeltasRef.current = [];
      clearTimer();

      // ── Phase 1: merge text deltas into per-message accumulators ──
      for (const d of deltas) {
        if (d.deltaType === 'text') {
          const prev = textAccumRef.current.get(d.messageId) || '';
          textAccumRef.current.set(d.messageId, prev + d.text);
        }
      }

      // ── Phase 2: build dispatch list ──
      const dispatches: PendingDelta[] = [];

      // Non-text deltas always pass through immediately (no accumulation).
      for (const d of deltas) {
        if (d.deltaType !== 'text') {
          dispatches.push(d);
        }
      }

      // Text deltas: split into individual lines at \n, keep incomplete
      // portion in the accumulator. No timeout — only a newline or an
      // explicit force-flush (block transition, stream end) delivers text.
      for (const [msgId, text] of textAccumRef.current) {
        if (force) {
          if (text.length > 0) {
            dispatches.push({ messageId: msgId, deltaType: 'text', text });
          }
          textAccumRef.current.delete(msgId);
        } else {
          const lastNewline = text.lastIndexOf('\n');
          if (lastNewline >= 0) {
            const complete = text.substring(0, lastNewline + 1);
            const remaining = text.substring(lastNewline + 1);

            // Dispatch each complete line individually so the reducer
            // processes them one line at a time instead of as one chunk.
            let pos = 0;
            let nextBreak: number;
            while ((nextBreak = complete.indexOf('\n', pos)) !== -1) {
              dispatches.push({
                messageId: msgId,
                deltaType: 'text',
                text: complete.substring(pos, nextBreak + 1),
              });
              pos = nextBreak + 1;
            }

            if (remaining.length > 0) {
              textAccumRef.current.set(msgId, remaining);
            } else {
              textAccumRef.current.delete(msgId);
            }
          }
          // No newline: keep accumulating silently, no dispatch.
        }
      }

      // ── Phase 3: dispatch (batched if possible) ──
      if (dispatches.length > 0) {
        const apply = () => {
          for (const d of dispatches) {
            dispatch({
              type: 'APPEND_BLOCK_DELTA',
              messageId: d.messageId,
              deltaType: d.deltaType,
              text: d.text,
            });
          }
        };
        if (batchedUpdates) {
          batchedUpdates(apply);
        } else {
          apply();
        }
      }

      // ── Phase 4: re-schedule if text is still pending ──
      // Only re-schedule when there are pending text deltas waiting for a
      // newline. The 60ms timer acts as a safety net: if the stream stalls
      // mid-line, the timer re-checks the accumulator in case a \n arrived
      // via a race (unlikely but safe).
      if (textAccumRef.current.size > 0) {
        const hasPendingNewline = Array.from(
          textAccumRef.current.values(),
        ).some((t) => t.includes('\n'));
        flushTimerRef.current = setTimeout(
          () => flushDeltas(false),
          hasPendingNewline ? 0 : DELTA_FLUSH_INTERVAL,
        );
      }
    },
    [dispatch, batchedUpdates, clearTimer],
  );

  const scheduleFlush = useCallback(() => {
    // Always clear and re-evaluate: a new delta may have arrived with a \n
    // while the previous timer was still pending.
    clearTimer();

    const hasNewline =
      pendingDeltasRef.current.some(
        (d) => d.deltaType === 'text' && d.text.includes('\n'),
      ) ||
      Array.from(textAccumRef.current.values()).some((t) => t.includes('\n'));

    flushTimerRef.current = setTimeout(
      () => flushDeltas(false),
      hasNewline ? 0 : DELTA_FLUSH_INTERVAL,
    );
  }, [flushDeltas, clearTimer]);

  return { pendingDeltasRef, flushDeltas, scheduleFlush } as const;
}
