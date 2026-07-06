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
}: ThinkingBlockProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="my-2">
      <motion.button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`
          flex items-center gap-2 py-1 text-xs font-medium
          cursor-pointer transition-colors duration-100
          text-[var(--color-text-secondary)]
          hover:text-[var(--color-text-primary)]
        `}
      >
        <motion.span
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
        >
          <ChevronRight size={12} className="text-[var(--color-text-tertiary)]" />
        </motion.span>
        <Brain size={13} className="text-[var(--color-info)]" />
        <span className="flex-1 text-left">Thinking</span>
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
      </motion.button>

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
                {content}
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
