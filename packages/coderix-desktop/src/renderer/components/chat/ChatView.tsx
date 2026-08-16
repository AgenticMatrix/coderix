import React, { useRef, useEffect, useState, useCallback, useLayoutEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Zap } from 'lucide-react';
import type { StreamBlock } from '../../types';
import { ContentBlockRenderer } from './ContentBlockRenderer';
import './ChatView.css';

export interface ChatViewMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: StreamBlock[];
  /** Timestamp */
  timestamp?: number;
  /** Model name (for assistant messages) */
  model?: string;
  /** Whether the message is still streaming */
  isStreaming?: boolean;
  /** Whether this starts a new "group" (adds spacing above) */
  isGroupStart?: boolean;
}

export interface ChatViewProps {
  /** Messages to display */
  messages?: ChatViewMessage[];
  /** Whether to show the empty state */
  isEmpty?: boolean;
  /** Is a message currently streaming */
  isStreaming?: boolean;
  /** Callback when user scrolls to bottom */
  onScrollToBottom?: () => void;
}

// ---------------------------------------------------------------------------
// Memoized message bubble — prevents re-renders when AnimatePresence
// re-processes children whose underlying data hasn't changed.
// During streaming, only the last (streaming) message gets new blocks each
// delta; all historical messages keep the same `blocks` reference, so
// React.memo skips them entirely.
// ---------------------------------------------------------------------------

interface MessageBubbleContentProps {
  message: ChatViewMessage;
  isStreamingMsg: boolean;
  isAssistant: boolean;
}

const MessageBubbleContent = React.memo(
  function MessageBubbleContent({ message, isStreamingMsg, isAssistant }: MessageBubbleContentProps) {
    // Tool_result blocks belong to assistant-side rendering even when stored
    // in user-role messages (tool execution results are user messages in the API).
    const hasToolResult = message.blocks.some((b) => b.type === 'tool_result');
    const displayRole = hasToolResult && message.role === 'user' ? 'assistant' : message.role;
    const displayAsAssistant = isAssistant || (hasToolResult && message.role === 'user');

    return (
      <>
        <div
          className={`message-bubble ${displayRole} ${isStreamingMsg ? 'streaming' : ''}`}
        >
          {message.blocks.map((block, blockIdx) => (
            <ContentBlockRenderer
              key={`${message.id}-block-${blockIdx}`}
              block={block}
              isStreaming={
                isStreamingMsg &&
                blockIdx === message.blocks.length - 1
              }
            />
          ))}

          {/* User message timestamp — inline at bottom-right */}
          {!displayAsAssistant && message.timestamp && !isStreamingMsg && (
            <span className="message-time-inline">
              {formatMessageTime(message.timestamp)}
            </span>
          )}

        </div>

        {/* Assistant message model badge */}
        {displayAsAssistant && message.model && !isStreamingMsg && (
          <div className="message-meta">
            <span className="model-badge">
              <Zap size={10} />
              {message.model}
            </span>
          </div>
        )}
      </>
    );
  },
  (prev, next) => {
    // Skip re-render when message data hasn't actually changed.
    // `blocks` reference is stable for historical messages (same objects from
    // Zustand store); the streaming message gets a new `blocks` each delta
    // so it will still re-render on every stream update.
    return (
      prev.message.id === next.message.id &&
      prev.message.blocks === next.message.blocks &&
      prev.message.role === next.message.role &&
      prev.isStreamingMsg === next.isStreamingMsg
    );
  },
);

/**
 * ChatView — WeChat / Apple Messages style chat interface.
 * iMessage-like bubbles with rounded corners, code blocks with syntax highlighting,
 * collapsible thinking blocks, and smooth auto-scroll behavior.
 */
export function ChatView({
  messages = [],
  isEmpty = true,
  isStreaming = false,
}: ChatViewProps): React.ReactElement {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevMessageCountRef = useRef(messages.length);
  const userScrolledUpRef = useRef(false);

  const scrollToBottom = useCallback(
    (smooth = true) => {
      const container = containerRef.current;
      if (!container) return;

      if (smooth) {
        messagesEndRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'end',
        });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    },
    [],
  );

  // Track whether user has scrolled away from the bottom.
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    userScrolledUpRef.current = distanceFromBottom > 80;
    setShowScrollBtn(distanceFromBottom > 200);
  }, []);

  // Auto-scroll on new messages (smooth).
  useEffect(() => {
    const hasNewMessage = messages.length !== prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    if (hasNewMessage && !userScrolledUpRef.current) {
      scrollToBottom(!isStreaming);
    }
  }, [messages, isStreaming, scrollToBottom]);

  // Auto-follow during streaming: useLayoutEffect runs synchronously after
  // DOM mutations, before paint — sets scrollTop directly for zero jitter.
  useLayoutEffect(() => {
    if (!isStreaming || userScrolledUpRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  });

  // Reset scroll state and scroll to bottom when a new stream starts or on mount.
  useEffect(() => {
    if (isStreaming) {
      userScrolledUpRef.current = false;
    }
    scrollToBottom(false);
  }, [scrollToBottom]);

  // Empty state
  if (isEmpty && messages.length === 0) {
    return (
      <div className="chat-container">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <Zap size={24} className="text-[var(--color-brand)]" />
          </div>
          <h3 className="chat-empty-title">Ask Coderix anything</h3>
          <p className="chat-empty-subtitle">
            I can help with code review, debugging, refactoring, and more.
            Start by typing a message below.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-container">
      {/* Messages area */}
      <div
        ref={containerRef}
        className="chat-messages"
        onScroll={handleScroll}
      >
        <AnimatePresence initial={false}>
          {messages.map((message, index) => {
            const isUser = message.role === 'user';
            const isAssistant = message.role === 'assistant';
            const isLastMessage = index === messages.length - 1;
            const isStreamingMsg = isLastMessage && message.isStreaming;
            const showAvatar =
              isAssistant &&
              message.blocks.some((b) => b.type === 'text' || b.type === 'tool_result');

            return (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.2,
                  ease: [0, 0, 0.2, 1],
                }}
                className={`message-row ${message.role} ${message.isGroupStart ? 'group-start' : ''}`}
              >
                {isAssistant && (
                  <span
                    className="message-avatar"
                    style={showAvatar ? undefined : { visibility: 'hidden' }}
                    aria-hidden="true"
                  >
                    C
                  </span>
                )}
                <div className="message-body">
                  <MessageBubbleContent
                    message={message}
                    isStreamingMsg={isStreamingMsg ?? false}
                    isAssistant={isAssistant}
                  />
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Invisible scroll anchor — outside AnimatePresence so it never
            gets removed from the DOM during child reconciliation. */}
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
            Scroll to bottom
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

ChatView.displayName = 'ChatView';

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
