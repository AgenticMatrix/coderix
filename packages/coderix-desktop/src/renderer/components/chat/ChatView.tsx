import React, { useRef, useEffect, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Zap } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import type { TrajectoryCall } from './trajectory/trajectoryTypes';
import { TrajectoryCallCard } from './trajectory/TrajectoryCallCard';
import { TurnOutcomeLine } from './TurnOutcomeLine';
import type { TurnOutcome } from '../../turn-outcome.js';
import './ChatView.css';

export interface ChatViewProps {
  /** Conversation grouped into ZCode-style calls. */
  calls: TrajectoryCall[];
  /** Whether to show the empty state. */
  isEmpty: boolean;
  /** Whether a message is currently streaming. */
  isStreaming: boolean;
  /** Why the last turn stopped, shown under the final message. */
  outcome?: TurnOutcome;
  /** Whether the transcript still has pages above the loaded window. */
  hasMoreHistory?: boolean;
  /** Load one older page of history from disk. */
  onLoadOlder?: () => void;
  /** Whether an older page is being fetched right now. */
  loadingOlder?: boolean;
  /** Whether the tail page is still being read (suppresses the empty state). */
  loadingHistory?: boolean;
}

/** How many calls are mounted at once. Each call carries a full tool
 *  transcript, so rendering every loaded call keeps weeks of DOM alive. This
 *  is a *render* window over already-loaded history — separate from the
 *  paging window that decides how much history is loaded from disk. */
const INITIAL_VISIBLE_CALLS = 30;
const LOAD_MORE_CALLS = 20;

/**
 * ChatView — ZCode live-chat style conversation view.
 *
 * Each turn is a card: the user's message (always visible), a collapsible
 * "已工作 X 分 Y 秒" region holding the agent's thinking + tool calls (collapsed
 * by default, each block summarizing to one line), and the final answer text
 * (always visible). A "C+" circle marks the start of the agent's work.
 */
export function ChatView({
  calls,
  isEmpty,
  isStreaming,
  outcome,
  hasMoreHistory = false,
  onLoadOlder,
  loadingOlder = false,
  loadingHistory = false,
}: ChatViewProps): React.ReactElement {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_CALLS);
  const prevCallCountRef = useRef(calls.length);
  const userScrolledUpRef = useRef(false);
  const t = useT();

  const hiddenCount = Math.max(0, calls.length - visibleCount);
  const visibleCalls = useMemo(
    () => (hiddenCount > 0 ? calls.slice(hiddenCount) : calls),
    [calls, hiddenCount],
  );

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const container = containerRef.current;
      if (!container) return;
      if (smooth) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    },
    [],
  );

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 80;
    setShowScrollBtn(distanceFromBottom > 200);
  }, []);

  // "Show earlier" reveals another slice of the *render* window, and pulls the
  // next page from disk once the window has caught up with what is loaded.
  // Widening the window inserts calls above the viewport, so keep the message
  // the reader was looking at in place. (The async page that follows is
  // anchored by the head-growth effect below.)
  const handleShowEarlier = useCallback(() => {
    const container = containerRef.current;
    const before = container?.scrollHeight ?? 0;
    const wasFullyShown = hiddenCount === 0;
    setVisibleCount((n) => n + LOAD_MORE_CALLS);
    if (wasFullyShown && hasMoreHistory && !loadingOlder) onLoadOlder?.();
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollTop += container.scrollHeight - before;
    });
  }, [hiddenCount, hasMoreHistory, loadingOlder, onLoadOlder]);

  // An older page landing prepends calls, which must not move what the reader
  // is looking at. Raise the window by however many arrived (otherwise the page
  // they just asked for stays hidden), then restore the scroll offset by the
  // height that was inserted. Only growth at the head counts — a new turn at
  // the tail is handled by the auto-follow effect.
  const prevFirstKeyRef = useRef(calls[0]?.key);
  const prevCallCountForHeadRef = useRef(calls.length);
  const headGrewRef = useRef(false);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const firstKey = calls[0]?.key;
    const grewAtHead =
      prevFirstKeyRef.current !== undefined && firstKey !== prevFirstKeyRef.current;
    const grew = calls.length - prevCallCountForHeadRef.current;
    prevFirstKeyRef.current = firstKey;
    prevCallCountForHeadRef.current = calls.length;
    headGrewRef.current = grewAtHead && grew > 0;
    if (!headGrewRef.current) return;

    // The prepended calls are still behind the window, so measuring before the
    // window widens captures the height the reader is currently looking at.
    const before = container?.scrollHeight ?? 0;
    setVisibleCount((n) => n + grew);
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollTop += container.scrollHeight - before;
    });
  }, [calls]);

  // Auto-scroll on a new turn at the tail (smooth). Growth at the head is the
  // paging case above and must not yank the reader to the bottom.
  useEffect(() => {
    const hasNewCall = calls.length !== prevCallCountRef.current;
    prevCallCountRef.current = calls.length;
    const grewAtHead = headGrewRef.current;
    headGrewRef.current = false;
    if (hasNewCall && !grewAtHead && !userScrolledUpRef.current) {
      scrollToBottom(!isStreaming);
    }
  }, [calls, isStreaming, scrollToBottom]);

  // Auto-follow during streaming.
  useLayoutEffect(() => {
    if (!isStreaming || userScrolledUpRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  });

  useEffect(() => {
    if (isStreaming) userScrolledUpRef.current = false;
    scrollToBottom(false);
  }, [scrollToBottom]);

  // The button appears while either layer still has more: calls hidden by the
  // render window, or pages not yet loaded from disk.
  const canShowEarlier = hiddenCount > 0 || (hasMoreHistory && Boolean(onLoadOlder));
  const totalHidden = hiddenCount;

  // Hold the empty state while the tail page is still arriving — otherwise a
  // slow read would flash "no messages" over a real conversation.
  if (isEmpty && calls.length === 0 && !loadingHistory) {
    return (
      <div className="chat-container">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <Zap size={24} className="text-[var(--color-brand)]" />
          </div>
          <h3 className="chat-empty-title">{t('chat.emptyTitle')}</h3>
          <p className="chat-empty-subtitle">{t('chat.emptySubtitle')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-container">
      <div ref={containerRef} className="chat-messages" onScroll={handleScroll}>
        {canShowEarlier && (
          <div className="trajectory-history-toggle">
            <button
              type="button"
              className="trajectory-history-btn"
              onClick={handleShowEarlier}
              disabled={loadingOlder}
            >
              {loadingOlder ? t('chat.loadingEarlier') : t('chat.showEarlier')}
            </button>
            {totalHidden > 0 && (
              <span className="trajectory-history-hint">
                {t('chat.hiddenCalls', { count: totalHidden })}
              </span>
            )}
          </div>
        )}
        <AnimatePresence initial={false}>
          {visibleCalls.map((call) => (
            <motion.div
              key={call.key}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
              className="trajectory-call-wrapper"
            >
              <TrajectoryCallCard call={call} />
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Why the last turn stopped — sits under the final message, quiet
            enough to read as context rather than an alert. */}
        {outcome && <TurnOutcomeLine outcome={outcome} />}

        <div ref={messagesEndRef} />
      </div>

      {/* Scroll-to-bottom floating button */}
      <AnimatePresence>
        {showScrollBtn && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 10 }}
            transition={{ duration: 0.15 }}
            onClick={() => scrollToBottom(true)}
            className="scroll-bottom-btn"
          >
            <ChevronDown size={14} />
            {t('chat.scrollToBottom')}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

ChatView.displayName = 'ChatView';
