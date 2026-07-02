import React, { useRef, useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Sparkles } from 'lucide-react';
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
  const [isNearBottom, setIsNearBottom] = useState(true);

  // Auto-scroll when new content arrives (if user is near the bottom)
  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      block: 'end',
    });
  }, []);

  // Track whether user has scrolled up
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    setIsNearBottom(distanceFromBottom < 80);
    setShowScrollBtn(distanceFromBottom > 200);
  }, []);

  // Auto-scroll on new messages or streaming
  useEffect(() => {
    if (isNearBottom) {
      scrollToBottom(true);
    }
  }, [messages, isStreaming, isNearBottom, scrollToBottom]);

  // Initial scroll to bottom
  useEffect(() => {
    scrollToBottom(false);
  }, [scrollToBottom]);

  // Empty state
  if (isEmpty && messages.length === 0) {
    return (
      <div className="chat-container">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <Sparkles size={24} className="text-[var(--color-brand)]" />
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

            return (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.2,
                  ease: [0, 0, 0.2, 1],
                }}
                className={`message-row ${message.role} ${message.isGroupStart ? 'group-start' : ''}`}
              >
                <div
                  className={`message-bubble ${message.role} ${isStreamingMsg ? 'streaming' : ''}`}
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

                  {/* Blinking cursor during streaming */}
                  {isStreamingMsg && (
                    <span className="streaming-cursor" />
                  )}
                </div>

                {/* Message timestamp / metadata */}
                {message.timestamp && !isStreamingMsg && (
                  <div className="message-meta">
                    {message.model && isAssistant && (
                      <span className="model-badge">
                        <Sparkles size={10} />
                        {message.model}
                      </span>
                    )}
                    <span>{formatMessageTime(message.timestamp)}</span>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* Invisible scroll anchor */}
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
