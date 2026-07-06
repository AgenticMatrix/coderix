import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Wrench, CheckCircle2, XCircle, Loader2, ChevronRight, Clock } from 'lucide-react';
import './ToolCallCard.css';

export interface ToolCallCardProps {
  /** Tool name */
  toolName: string;
  /** Tool input parameters */
  toolInput?: Record<string, unknown>;
  /** Tool result (when completed) */
  toolResult?: string;
  /** Current state */
  state: 'pending' | 'executing' | 'done' | 'error';
  /** Execution time in milliseconds */
  executionTime?: number;
  /** Tool call ID */
  toolId?: string;
}

const stateConfig: Record<ToolCallCardProps['state'], {
  icon: React.ReactNode;
  label: string;
  color: string;
  bgClass: string;
}> = {
  pending: {
    icon: <Clock size={13} />,
    label: 'Pending',
    color: 'text-[var(--color-text-tertiary)]',
    bgClass: 'border-[var(--color-separator)]',
  },
  executing: {
    icon: <Loader2 size={13} className="animate-spin" />,
    label: 'Executing…',
    color: 'text-[var(--color-info)]',
    bgClass: 'border-[var(--color-info)]/30',
  },
  done: {
    icon: <CheckCircle2 size={13} />,
    label: 'Done',
    color: 'text-[var(--color-success)]',
    bgClass: 'border-[var(--color-success)]/20',
  },
  error: {
    icon: <XCircle size={13} />,
    label: 'Error',
    color: 'text-[var(--color-danger)]',
    bgClass: 'border-[var(--color-danger)]/20',
  },
};

function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncateParamValue(value: unknown, maxLen = 80): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

export function ToolCallCard({
  toolName,
  toolInput,
  toolResult,
  state,
  executionTime,
  toolId,
}: ToolCallCardProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);

  const cfg = stateConfig[state];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="my-2"
    >
      {/* Header */}
      <motion.button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 py-1 text-xs cursor-pointer transition-colors duration-100 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
      >
        <motion.span
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
        >
          <ChevronRight size={10} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
        </motion.span>
        <span className={`flex-shrink-0 ${cfg.color}`}>
          {cfg.icon}
        </span>
        <Wrench size={13} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
        <span className="font-medium text-[var(--color-text-primary)]">{toolName}</span>

        <div className="flex-1" />

        {executionTime !== undefined && state === 'done' && (
          <span className="text-[11px] text-[var(--color-text-tertiary)]">
            {formatTime(executionTime)}
          </span>
        )}
        <span className={`text-[11px] font-medium ${cfg.color}`}>
          {cfg.label}
        </span>
      </motion.button>

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
            <div className="pb-3 space-y-2">
              {/* Tool input */}
              {toolInput && Object.keys(toolInput).length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1">
                    Parameters
                  </div>
                  <div className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs">
                    {Object.entries(toolInput).map(([key, value]) => (
                      <div key={key} className="flex gap-2 py-0.5">
                        <span className="text-[var(--color-info)] font-mono flex-shrink-0">{key}:</span>
                        <span className="text-[var(--color-text-secondary)] font-mono break-all">
                          {truncateParamValue(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tool result */}
              {toolResult && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1">
                    Result
                  </div>
                  <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-words leading-[18px] m-0 max-h-48 overflow-y-auto">
                    {toolResult}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

ToolCallCard.displayName = 'ToolCallCard';
