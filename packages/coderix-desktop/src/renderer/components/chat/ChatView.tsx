import React, { useRef, useEffect, useState, useCallback, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Zap, Search } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import type { TrajectoryCall } from './trajectory/trajectoryTypes';
import { TrajectoryCallCard } from './trajectory/TrajectoryCallCard';
import { buildTrajectorySearchIndex } from './trajectory/TrajectorySearch';
import { TrajectorySearchBar } from './trajectory/TrajectorySearchBar';
import {
  collectMatchRanges,
  applyHighlights,
  clearHighlights,
  scrollRangeIntoView,
} from './trajectory/TrajectorySearchHighlight';
import './ChatView.css';

export interface ChatViewProps {
  /** Conversation grouped into ZCode-style calls. */
  calls: TrajectoryCall[];
  /** Whether to show the empty state. */
  isEmpty: boolean;
  /** Whether a message is currently streaming. */
  isStreaming: boolean;
}

/**
 * ChatView — ZCode live-chat style conversation view.
 *
 * Each turn is a card: the user's message (always visible), a collapsible
 * "已工作 X 分 Y 秒" region holding the agent's thinking + tool calls (collapsed
 * by default, each block summarizing to one line), and the final answer text
 * (always visible). A "C+" circle marks the start of the agent's work. A
 * find-in-conversation search bar highlights and navigates matches across every
 * message (including collapsed thinking/tool content).
 */
export function ChatView({ calls, isEmpty, isStreaming }: ChatViewProps): React.ReactElement {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevCallCountRef = useRef(calls.length);
  const userScrolledUpRef = useRef(false);
  const t = useT();

  // ── Search state ───────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [revealedRowKeys, setRevealedRowKeys] = useState<Set<string>>(new Set());
  const rangesRef = useRef<Range[]>([]);

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

  // ── Search: expand matching rows from the data model ──────
  useEffect(() => {
    if (!searchQuery.trim()) {
      setRevealedRowKeys(new Set());
      rangesRef.current = [];
      setMatchCount(0);
      clearHighlights();
      return;
    }
    const { matchingRowKeys } = buildTrajectorySearchIndex(calls, searchQuery);
    setRevealedRowKeys(matchingRowKeys);
  }, [searchQuery, calls]);

  // ── Search: collect DOM ranges + highlight after expansion ─
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const root = containerRef.current;
    if (!root) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const ranges = collectMatchRanges(root, searchQuery);
        rangesRef.current = ranges;
        const clamped = Math.min(searchActiveIndex, Math.max(0, ranges.length - 1));
        setSearchActiveIndex(clamped);
        setMatchCount(ranges.length);
        applyHighlights(ranges, clamped);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [searchQuery, revealedRowKeys, calls]);

  const navigateSearch = useCallback(
    (direction: 1 | -1) => {
      const ranges = rangesRef.current;
      const container = containerRef.current;
      if (!ranges.length || !container) return;
      const next = (searchActiveIndex + direction + ranges.length) % ranges.length;
      setSearchActiveIndex(next);
      applyHighlights(ranges, next);
      scrollRangeIntoView(ranges[next], container);
    },
    [searchActiveIndex],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchActiveIndex(0);
    setMatchCount(0);
    setRevealedRowKeys(new Set());
    rangesRef.current = [];
    clearHighlights();
  }, []);

  // Cleanup highlights on unmount.
  useEffect(() => clearHighlights, []);

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
      {searchOpen && (
        <TrajectorySearchBar
          query={searchQuery}
          onQueryChange={(q) => {
            setSearchQuery(q);
            setSearchActiveIndex(0);
          }}
          matchCount={matchCount}
          activeIndex={searchActiveIndex}
          onNext={() => navigateSearch(1)}
          onPrev={() => navigateSearch(-1)}
          onClose={closeSearch}
        />
      )}

      {/* Search toggle */}
      <button
        type="button"
        className="trajectory-search-toggle"
        onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
        title="Search"
        aria-label="Search"
      >
        <Search size={14} />
      </button>

      <div ref={containerRef} className="chat-messages" onScroll={handleScroll}>
        <AnimatePresence initial={false}>
          {calls.map((call) => (
            <motion.div
              key={call.key}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
              className="trajectory-call-wrapper"
            >
              <TrajectoryCallCard call={call} revealRowKeys={revealedRowKeys} />
            </motion.div>
          ))}
        </AnimatePresence>

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
