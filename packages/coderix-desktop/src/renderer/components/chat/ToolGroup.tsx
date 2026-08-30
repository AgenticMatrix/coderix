import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { StreamBlock } from '../../types';
import { useUIStore } from '../../store/uiStore';
import { ToolRenderer } from './ToolRenderer';

export interface ToolGroupProps {
  /** The tool_use blocks to group together (rendered after text). */
  tools: StreamBlock[];
}

/**
 * Maps a tool name to a human-readable summary category so a run of tool
 * calls collapses into a compact phrase like "run 2 commands, read 2 files".
 * Tools that share a category merge their counts — write + update → "edit N
 * files", glob + grep → "search N patterns".
 */
const TOOL_CATEGORY: Record<
  string,
  { verb: string; singular: string; plural: string }
> = {
  // Shell / commands
  bash: { verb: 'run', singular: 'command', plural: 'commands' },
  // File I/O
  read: { verb: 'read', singular: 'file', plural: 'files' },
  write: { verb: 'edit', singular: 'file', plural: 'files' },
  update: { verb: 'edit', singular: 'file', plural: 'files' },
  NotebookEdit: { verb: 'edit', singular: 'notebook', plural: 'notebooks' },
  // Search / fetch
  glob: { verb: 'search', singular: 'pattern', plural: 'patterns' },
  grep: { verb: 'search', singular: 'pattern', plural: 'patterns' },
  WebFetch: { verb: 'fetch', singular: 'page', plural: 'pages' },
  WebSearch: { verb: 'search', singular: 'query', plural: 'queries' },
  // Background tasks
  TaskCreate: { verb: 'create', singular: 'task', plural: 'tasks' },
  TaskList: { verb: 'list', singular: 'task', plural: 'tasks' },
  TaskGet: { verb: 'get', singular: 'task', plural: 'tasks' },
  TaskUpdate: { verb: 'update', singular: 'task', plural: 'tasks' },
  TaskStop: { verb: 'stop', singular: 'task', plural: 'tasks' },
  TaskOutput: { verb: 'read', singular: 'task output', plural: 'task outputs' },
  // Interaction
  skill: { verb: 'use', singular: 'skill', plural: 'skills' },
  AskUserQuestion: { verb: 'ask', singular: 'question', plural: 'questions' },
  Listen: { verb: 'listen', singular: 'time', plural: 'times' },
  // Plan mode / worktree
  EnterPlanMode: { verb: 'enter', singular: 'plan mode', plural: 'plan modes' },
  ExitPlanMode: { verb: 'exit', singular: 'plan mode', plural: 'plan modes' },
  EnterWorktree: { verb: 'enter', singular: 'worktree', plural: 'worktrees' },
  ExitWorktree: { verb: 'exit', singular: 'worktree', plural: 'worktrees' },
};

function buildToolSummary(tools: StreamBlock[]): string {
  const grouped = new Map<
    string,
    { verb: string; singular: string; plural: string; count: number }
  >();
  let other = 0;

  for (const tool of tools) {
    const category = TOOL_CATEGORY[tool.toolName ?? ''];
    if (!category) {
      other += 1;
      continue;
    }
    const key = `${category.verb}:${category.plural}`;
    const entry = grouped.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      grouped.set(key, { ...category, count: 1 });
    }
  }

  const parts: string[] = [];
  for (const { verb, singular, plural, count } of grouped.values()) {
    parts.push(`${verb} ${count} ${count === 1 ? singular : plural}`);
  }
  if (other > 0) {
    parts.push(`run ${other} ${other === 1 ? 'tool' : 'tools'}`);
  }

  if (parts.length === 0) {
    const count = tools.length;
    return count === 1 ? '1 tool used' : `${count} tools used`;
  }
  return parts.join(', ');
}

/**
 * ToolGroup — collapses a run of tool calls behind a single summary line
 * (e.g. "run 2 commands, read 2 files"). Rendering it after text keeps the
 * message readable; expanding reveals the individual tool cards (which stay
 * collapsed until clicked).
 */
export function ToolGroup({ tools }: ToolGroupProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const standardMode = useUIStore((s) => s.standardMode);

  const label = buildToolSummary(tools);

  return (
    <div className="mt-1 mb-2">
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className={`flex items-center gap-1.5 py-1 text-xs cursor-pointer transition-colors duration-100 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] w-full text-left ${standardMode ? '' : 'pl-5'}`}
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
