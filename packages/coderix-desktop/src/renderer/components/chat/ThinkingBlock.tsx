import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, ChevronRight } from 'lucide-react';
import { useT } from '../../i18n/index.js';

export interface ThinkingBlockProps {
  /** The thinking content */
  content: string;
  /** Whether the thinking block starts expanded */
  defaultExpanded?: boolean;
  /** Whether this is still streaming (shows spinner) */
  isStreaming?: boolean;
  /** Force-open (search reveal) regardless of the collapsed preference. */
  reveal?: boolean;
  /** Completed-state header label override, e.g. "已思考 4s". */
  label?: string;
}

export function ThinkingBlock({
  content,
  defaultExpanded = false,
  isStreaming = false,
  reveal = false,
  label,
}: ThinkingBlockProps): React.ReactElement | null {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const t = useT();

  const text = content ?? '';

  // While a thinking block is streaming, always render the reasoning text
  // expanded so the user sees it arrive in real time. A collapsed block only
  // shows a single truncated gray line, which during streaming reads as a
  // static "思考中" with no output — and looks like a hang. Once streaming
  // finishes we fall back to the user's collapsed/expanded preference.
  const expanded = isExpanded || isStreaming || reveal;

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
          <Brain size={13} className="text-[var(--color-info)] flex-shrink-0" />
          <span className="text-left">
            {isStreaming ? t('thinking.thinking') : (label ?? t('thinking.thought'))}
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
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
            className="ml-auto flex-shrink-0"
          >
            <ChevronRight size={12} className="text-[var(--color-text-tertiary)]" />
          </motion.span>
        </button>
      </div>

      {/* Expanded content — also inline, no box, no gap */}
      <AnimatePresence>
        {expanded && (
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
