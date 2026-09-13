import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { StreamBlock } from '../../types';
import { useUIStore } from '../../store/uiStore';
import { useT, type TranslationKey } from '../../i18n/index.js';
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
  { verb: TranslationKey; singular: TranslationKey; plural: TranslationKey }
> = {
  // Shell / commands
  bash: { verb: 'toolcat.run', singular: 'toolcat.command', plural: 'toolcat.commands' },
  // File I/O
  read: { verb: 'toolcat.read', singular: 'toolcat.file', plural: 'toolcat.files' },
  write: { verb: 'toolcat.edit', singular: 'toolcat.file', plural: 'toolcat.files' },
  update: { verb: 'toolcat.edit', singular: 'toolcat.file', plural: 'toolcat.files' },
  NotebookEdit: { verb: 'toolcat.edit', singular: 'toolcat.notebook', plural: 'toolcat.notebooks' },
  // Search / fetch
  glob: { verb: 'toolcat.search', singular: 'toolcat.pattern', plural: 'toolcat.patterns' },
  grep: { verb: 'toolcat.search', singular: 'toolcat.pattern', plural: 'toolcat.patterns' },
  WebFetch: { verb: 'toolcat.fetch', singular: 'toolcat.page', plural: 'toolcat.pages' },
  WebSearch: { verb: 'toolcat.search', singular: 'toolcat.query', plural: 'toolcat.queries' },
  // Background tasks
  TaskCreate: { verb: 'toolcat.create', singular: 'toolcat.task', plural: 'toolcat.tasks' },
  TaskList: { verb: 'toolcat.list', singular: 'toolcat.task', plural: 'toolcat.tasks' },
  TaskGet: { verb: 'toolcat.get', singular: 'toolcat.task', plural: 'toolcat.tasks' },
  TaskUpdate: { verb: 'toolcat.update', singular: 'toolcat.task', plural: 'toolcat.tasks' },
  TaskStop: { verb: 'toolcat.stop', singular: 'toolcat.task', plural: 'toolcat.tasks' },
  TaskOutput: { verb: 'toolcat.read', singular: 'toolcat.taskOutput', plural: 'toolcat.taskOutputs' },
  // Interaction
  skill: { verb: 'toolcat.use', singular: 'toolcat.skill', plural: 'toolcat.skills' },
  AskUserQuestion: { verb: 'toolcat.ask', singular: 'toolcat.question', plural: 'toolcat.questions' },
  Listen: { verb: 'toolcat.listen', singular: 'toolcat.time', plural: 'toolcat.times' },
  // Plan mode / worktree
  EnterPlanMode: { verb: 'toolcat.enter', singular: 'toolcat.planMode', plural: 'toolcat.planModes' },
  ExitPlanMode: { verb: 'toolcat.exit', singular: 'toolcat.planMode', plural: 'toolcat.planModes' },
  EnterWorktree: { verb: 'toolcat.enter', singular: 'toolcat.worktree', plural: 'toolcat.worktrees' },
  ExitWorktree: { verb: 'toolcat.exit', singular: 'toolcat.worktree', plural: 'toolcat.worktrees' },
};

type ToolCategory = { verb: TranslationKey; singular: TranslationKey; plural: TranslationKey };

function buildToolSummary(
  tools: StreamBlock[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const grouped = new Map<string, ToolCategory & { count: number }>();
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
    const noun = t(count === 1 ? singular : plural, { n: count });
    parts.push(`${t(verb)} ${count} ${noun}`);
  }
  if (other > 0) {
    const noun = t(other === 1 ? 'toolcat.tool' : 'toolcat.tools', { n: other });
    parts.push(`${t('toolcat.run')} ${other} ${noun}`);
  }

  if (parts.length === 0) {
    const count = tools.length;
    return count === 1 ? t('toolcat.toolUsedOne') : t('toolcat.toolUsed', { n: count });
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
  const t = useT();

  const label = buildToolSummary(tools, t);

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
                  toolName={tool.toolName ?? t('common.unknown')}
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
