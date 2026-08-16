import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, ChevronRight, Copy, Check } from 'lucide-react';

export interface ThinkingBlockProps {
  /** The thinking content */
  content: string;
  /** Whether the thinking block starts expanded */
  defaultExpanded?: boolean;
  /** Whether this is still streaming (shows spinner) */
  isStreaming?: boolean;
}

const PREVIEW_LINES = 2;
const PREVIEW_CHARS_PER_LINE = 60;

export function ThinkingBlock({
  content,
  defaultExpanded = false,
  isStreaming = false,
}: ThinkingBlockProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const text = content ?? '';
  const totalLines = Math.max(
    text.split('\n').length,
    Math.ceil(text.length / PREVIEW_CHARS_PER_LINE),
  );
  const moreLines = Math.max(totalLines - PREVIEW_LINES, 0);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="my-2">
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
        <button
          type="button"
          className="p-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] rounded-[var(--radius-xs)] transition-colors flex-shrink-0"
          onClick={handleCopy}
          title="Copy"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>

      {/* Collapsed preview — first two lines + "N lines more" */}
      {!isExpanded && text.trim() !== '' && (
        <div className="pl-5 pr-1">
          <div className="py-1.5 px-2.5 rounded-[var(--radius-md)] bg-[var(--color-bg-secondary)]/40 border-l-2 border-[var(--color-info)]/25">
            <div className="text-xs text-[var(--color-text-tertiary)] font-mono leading-[18px] whitespace-pre-wrap break-words max-h-[36px] overflow-hidden">
              {text}
            </div>
            {moreLines > 0 && (
              <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">
                {moreLines} lines more…
              </div>
            )}
          </div>
        </div>
      )}

      {/* Expanded content */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="py-2 mt-1 rounded-[var(--radius-md)] bg-[var(--color-bg-secondary)]/30 border-l-2 border-[var(--color-info)]/30">
              <pre className="text-xs text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-words leading-[18px] m-0">
                {text}
                {isStreaming && (
                  <motion.span
                    animate={{ opacity: [1, 0] }}
                    transition={{ repeat: Infinity, duration: 0.8 }}
                    className="ml-0.5 inline-block w-2 h-[14px] bg-[var(--color-text-tertiary)] align-middle"
                  />
                )}
              </pre>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

ThinkingBlock.displayName = 'ThinkingBlock';
