import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { StreamBlock } from '../../types';
import { ToolRenderer } from './ToolRenderer';

export interface ToolGroupProps {
  /** The tool_use blocks to group together (rendered after text). */
  tools: StreamBlock[];
}

/**
 * ToolGroup — collapses a run of tool calls behind a single "N tools used"
 * summary line. Rendering it after text keeps the message readable; expanding
 * reveals the individual tool cards (which stay collapsed until clicked).
 */
export function ToolGroup({ tools }: ToolGroupProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);

  const count = tools.length;
  const label = count === 1 ? '1 tool used' : `${count} tools used`;

  return (
    <div className="mt-1 mb-2">
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex items-center gap-1.5 py-1 text-xs cursor-pointer transition-colors duration-100 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] w-full text-left"
      >
        <motion.span
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="flex-shrink-0"
        >
          <ChevronRight size={12} className="text-[var(--color-text-tertiary)]" />
        </motion.span>
        <span className="font-medium">{label}</span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="pl-5 border-l-2 border-[var(--color-separator)]">
              {tools.map((tool, idx) => (
                <ToolRenderer
                  key={tool.toolId ?? `tool-${idx}`}
                  toolName={tool.toolName ?? 'Unknown'}
                  toolInput={tool.toolInput}
                  state={tool.state}
                  toolId={tool.toolId}
                  toolResult={tool.toolResult}
                  toolMetadata={tool.toolMetadata}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

ToolGroup.displayName = 'ToolGroup';
