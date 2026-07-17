import { useRef } from 'react';
import { Box } from '@coderix/ink';
import type { DOMElement } from '@coderix/ink';
import type { ScrollBoxHandle } from '@coderix/ink';
import { useVirtualScroll } from '@coderix/ink';
import type { Message } from '../../types.js';
import { ErrorBoundary } from './ErrorBoundary.js';

const MAX_MOUNTED = 200;
const OVERSCAN = 40;
const DEFAULT_ESTIMATE = 3;

export interface VirtualMessageListProps {
  messages: Message[];
  scrollRef: React.RefObject<ScrollBoxHandle | null>;
  columns: number;
  /**
   * Stable function that returns a unique key for each message.
   * Defaults to `msg.id.toString()`.
   */
  getKey?: (msg: Message) => string;
  /**
   * Render a single message row. The returned element gets wrapped in a
   * measurement Box that captures Yoga height.
   */
  renderMessage: (msg: Message, index: number) => React.ReactNode;
}

/**
 * Virtual-scrolled message list. Only mounts messages within the visible
 * viewport plus overscan; screen-外 items are represented by spacer boxes
 * that preserve the scroll position at O(1) fiber cost.
 *
 * Integrates with @coderix/ink's ScrollBox — attach `scrollRef` to the
 * parent ScrollBox via its imperative handle ref.
 */
export function VirtualMessageList({
  messages,
  scrollRef,
  columns,
  getKey,
  renderMessage,
}: VirtualMessageListProps): React.ReactNode {
  const resolveKey = getKey ?? ((msg: Message) => String(msg.id));

  // ── Incremental key array (avoids O(n) rebuild on streaming append) ──
  const keysRef = useRef<string[]>([]);
  const prevLenRef = useRef(0);
  const prevFirstRef = useRef<Message | null>(null);
  const prevKeyFn = useRef(getKey);

  if (
    prevKeyFn.current !== getKey ||
    messages.length < keysRef.current.length ||
    messages[0] !== prevFirstRef.current
  ) {
    // Full rebuild: key function changed, compaction, or /clear.
    keysRef.current = messages.map((m) => resolveKey(m));
  } else {
    // Append-only delta: push new keys for newly arrived messages.
    for (let i = keysRef.current.length; i < messages.length; i++) {
      keysRef.current.push(resolveKey(messages[i]!));
    }
  }
  prevLenRef.current = messages.length;
  prevFirstRef.current = messages[0] ?? null;
  prevKeyFn.current = getKey;
  const keys = keysRef.current;

  const { range, topSpacer, bottomSpacer, measureRef, spacerRef } =
    useVirtualScroll(scrollRef, keys, columns, {
      maxMounted: MAX_MOUNTED,
      overscan: OVERSCAN,
      estimateHeight: DEFAULT_ESTIMATE,
    });

  const [start, end] = range;

  // Memo the sliced list so React reconciliation is stable between renders
  // where the range hasn't changed.
  const visibleItems = messages.slice(start, end);

  return (
    <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {visibleItems.map((msg, i) => {
        const idx = start + i;
        const key = keys[idx]!;
        return (
          <ErrorBoundary key={key} name={`Msg-${msg.role}-${key}`}>
            <Box ref={measureRef(key)} flexDirection="column">
              {renderMessage(msg, idx)}
            </Box>
          </ErrorBoundary>
        );
      })}
      {bottomSpacer > 0 && <Box height={bottomSpacer} flexShrink={0} />}
    </>
  );
}
