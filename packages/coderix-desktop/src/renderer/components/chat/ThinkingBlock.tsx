import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, ChevronRight } from 'lucide-react';

export interface ThinkingBlockProps {
  /** The thinking content */
  content: string;
  /** Whether the thinking block starts expanded */
  defaultExpanded?: boolean;
  /** Whether this is still streaming (shows spinner) */
  isStreaming?: boolean;
}

export function ThinkingBlock({
  content,
  defaultExpanded = false,
  isStreaming = false,
}: ThinkingBlockProps): React.ReactElement | null {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const text = content ?? '';

  // Collapsed preview shows just the first non-empty line plus a "... N more
  // lines" hint instead of clamping two lines of raw reasoning.
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const firstLine = lines[0] ?? '';
  const remainingLines = Math.max(0, lines.length - 1);

  // Empty thinking blocks (a persisted block with no reasoning text) render
  // nothing — no "Thought" label, no brain icon, no copy button. During
  // streaming we still show the "Thinking…" header so the user sees the model
  // is reasoning even before the first delta arrives.
  if (text.trim() === '' && !isStreaming) return null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={`
            flex items-center gap-2 py-1 text-xs font-medium flex-1 min-w-0
            cursor-pointer transition-colors duration-100
            text-[var(--color-text-secondary)]
            hover:text-[var(--color-text-primary)]
          `}
        >
          <motion.span
            animate={{ rotate: isExpanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
            className="flex-shrink-0"
          >
            <ChevronRight size={12} className="text-[var(--color-text-tertiary)]" />
          </motion.span>
          <Brain size={13} className="text-[var(--color-info)] flex-shrink-0" />
          <span className="text-left">
            {isStreaming ? 'Thinking' : 'Thought'}
          </span>
          {isStreaming && (
            <span className="inline-flex gap-0.5">
              <motion.span
                className="w-1 h-1 rounded-full bg-[var(--color-info)]"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: 0 }}
              />
              <motion.span
                className="w-1 h-1 rounded-full bg-[var(--color-info)]"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: 0.2 }}
              />
              <motion.span
                className="w-1 h-1 rounded-full bg-[var(--color-info)]"
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ repeat: Infinity, duration: 1.2, delay: 0.4 }}
              />
            </span>
          )}
        </button>
      </div>

      {/* Collapsed preview — one line of reasoning plus a "... N more lines"
          hint. Rendered inline (no box, no gap) right below the header. */}
      {!isExpanded && text.trim() !== '' && (
        <div className="pl-5">
          <div className="text-xs text-[var(--color-text-secondary)] font-mono leading-[18px] m-0 truncate">
            {firstLine}
          </div>
          {remainingLines > 0 && (
            <div className="text-xs text-[var(--color-text-tertiary)] font-mono leading-[18px] m-0">
              ... {remainingLines} more {remainingLines === 1 ? 'line' : 'lines'}
            </div>
          )}
        </div>
      )}

      {/* Expanded content — also inline, no box, no gap */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="text-xs text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-words leading-[18px] m-0 pl-5">
              {text}
              {isStreaming && (
                <motion.span
                  animate={{ opacity: [1, 0] }}
                  transition={{ repeat: Infinity, duration: 0.8 }}
                  className="ml-0.5 inline-block w-2 h-[14px] bg-[var(--color-text-tertiary)] align-middle"
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

ThinkingBlock.displayName = 'ThinkingBlock';
