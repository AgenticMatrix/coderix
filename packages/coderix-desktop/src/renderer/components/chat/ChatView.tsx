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
}

/** Only the tail of the conversation is mounted. Each call carries a full tool
 *  transcript, so rendering all of them keeps weeks of DOM alive. */
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
export function ChatView({ calls, isEmpty, isStreaming, outcome }: ChatViewProps): React.ReactElement {
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

  // Expanding the window inserts calls above the viewport; keep the message
  // the user was reading in place instead of letting it jump downward.
  const handleShowEarlier = useCallback(() => {
    const container = containerRef.current;
    const before = container?.scrollHeight ?? 0;
    setVisibleCount((n) => n + LOAD_MORE_CALLS);
    requestAnimationFrame(() => {
      if (!container) return;
      container.scrollTop += container.scrollHeight - before;
    });
  }, []);

  // Auto-scroll on new calls (smooth).
  useEffect(() => {
    const hasNewCall = calls.length !== prevCallCountRef.current;
    prevCallCountRef.current = calls.length;
    if (hasNewCall && !userScrolledUpRef.current) {
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

  if (isEmpty && calls.length === 0) {
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
        {hiddenCount > 0 && (
          <div className="trajectory-history-toggle">
            <button
              type="button"
              className="trajectory-history-btn"
              onClick={handleShowEarlier}
            >
              {t('chat.showEarlier')}
            </button>
            <span className="trajectory-history-hint">
              {t('chat.hiddenCalls', { count: hiddenCount })}
            </span>
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
