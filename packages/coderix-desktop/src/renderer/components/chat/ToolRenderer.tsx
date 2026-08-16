import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock, ChevronRight, CheckCircle2, XCircle, Loader2, Copy, Check,
} from 'lucide-react';
import type { StreamBlock } from '../../types';

// ── Tool Display Config ────────────────────────────────────
// Each tool gets a display name + a `content` builder so the collapsed
// header reads naturally, e.g. "Bash (npm install)", "Read (src/app.ts)".

interface ToolDisplayConfig {
  name: string;
  content: (input: Record<string, unknown>) => string;
}

function truncate(text: string, max = 60): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function truncatePath(path: string, max = 80): string {
  if (!path) return '';
  if (path.length <= max) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return path.slice(0, max) + '…';
  return `…/${parts[parts.length - 1]}`;
}

const toolConfigs: Record<string, ToolDisplayConfig> = {
  read: {
    name: 'Read',
    content: (i) => truncatePath((i.file_path as string) || (i.path as string) || ''),
  },
  write: {
    name: 'Write',
    content: (i) => truncatePath((i.file_path as string) || (i.path as string) || ''),
  },
  update: {
    name: 'Update',
    content: (i) => truncatePath((i.file_path as string) || (i.path as string) || ''),
  },
  bash: {
    name: 'Bash',
    content: (i) => truncate((i.description as string) || '', 60),
  },
  glob: {
    name: 'Glob',
    content: (i) => truncate((i.pattern as string) || (i.path as string) || '', 60),
  },
  grep: {
    name: 'Grep',
    content: (i) => truncate((i.pattern as string) || '', 60),
  },
  webfetch: {
    name: 'WebFetch',
    content: (i) => truncate((i.url as string) || '', 60),
  },
  websearch: {
    name: 'WebSearch',
    content: (i) => truncate((i.query as string) || '', 50),
  },
  taskcreate: {
    name: 'TaskCreate',
    content: (i) => {
      const af = i.activeForm as string | undefined;
      const d = i.description as string | undefined;
      if (af && d) return truncate(`${af}: ${d}`, 50);
      return truncate(af || d || '', 50);
    },
  },
  taskupdate: {
    name: 'TaskUpdate',
    content: (i) => truncate((i.taskId as string) || '', 30),
  },
  tasklist: {
    name: 'TaskList',
    content: () => '',
  },
  taskget: {
    name: 'TaskGet',
    content: (i) => truncate((i.taskId as string) || '', 30),
  },
  taskoutput: {
    name: 'TaskOutput',
    content: (i) => truncate((i.task_id as string) || '', 30),
  },
  taskstop: {
    name: 'TaskStop',
    content: (i) => truncate((i.task_id as string) || '', 30),
  },
  todowrite: {
    name: 'TodoWrite',
    content: (i) => {
      const todos = i.newTodos || i.todos;
      const n = Array.isArray(todos) ? todos.length : 0;
      return n ? `${n} items` : '';
    },
  },
  skill: {
    name: 'Skill',
    content: (i) => truncate((i.skill as string) || (i.command as string) || '', 40),
  },
  askuserquestion: {
    name: 'Ask',
    content: (i) => {
      const qs = i.questions as Array<{ question?: string }> | undefined;
      return truncate(qs?.[0]?.question || '', 50);
    },
  },
  enterplanmode: {
    name: 'Enter Plan Mode',
    content: () => '',
  },
  exitplanmode: {
    name: 'Exit Plan Mode',
    content: () => '',
  },
  notebookedit: {
    name: 'NotebookEdit',
    content: (i) => truncatePath((i.notebook_path as string) || (i.file_path as string) || ''),
  },
  agent: {
    name: 'Agent',
    content: (i) => truncate((i.description as string) || (i.prompt as string) || '', 50),
  },
  sendmessage: {
    name: 'SendMessage',
    content: (i) => truncate((i.agent_name as string) || '', 40),
  },
  teamcreate: {
    name: 'TeamCreate',
    content: (i) => truncate((i.name as string) || '', 40),
  },
  teamdelete: {
    name: 'TeamDelete',
    content: (i) => truncate((i.name as string) || '', 40),
  },
  listen: {
    name: 'Listen',
    content: (i) => truncate((i.duration as string) || '', 20),
  },
  enterworktree: {
    name: 'EnterWorktree',
    content: (i) => truncate((i.name as string) || (i.path as string) || '', 40),
  },
  exitworktree: {
    name: 'ExitWorktree',
    content: (i) => truncate((i.action as string) || '', 40),
  },
  workflow: {
    name: 'Workflow',
    content: (i) => truncate((i.name as string) || '', 40),
  },
};

function getToolConfig(toolName: string): ToolDisplayConfig {
  return toolConfigs[toolName.toLowerCase()] ?? {
    name: toolName,
    content: () => '',
  };
}

// ── State Config ───────────────────────────────────────────

interface StateConfig {
  icon: React.ReactNode;
  className: string;
  label: string;
}

const stateConfigs: Record<string, StateConfig> = {
  pending: { icon: <Clock size={12} />, className: 'pending', label: 'Pending' },
  executing: { icon: <Loader2 size={12} className="animate-spin" />, className: 'executing', label: 'Running' },
  done: { icon: <CheckCircle2 size={12} />, className: 'done', label: 'Done' },
  error: { icon: <XCircle size={12} />, className: 'error', label: 'Error' },
};

// ── Helpers ────────────────────────────────────────────────

function renderParamValue(value: unknown, max = 160): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return truncate(str, max);
}

function KeyValueList({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  return (
    <div className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs font-mono">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2 py-0.5">
          <span className="text-[var(--color-info)] flex-shrink-0">{key}:</span>
          <span className="text-[var(--color-text-secondary)] break-all">
            {renderParamValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────

export interface ToolRendererProps {
  toolName: string;
  toolInput?: Record<string, unknown>;
  state?: StreamBlock['state'];
  toolId?: string;
  toolResult?: string;
  toolMetadata?: Record<string, unknown>;
}

export function ToolRenderer({
  toolName,
  toolInput = {},
  state = 'executing',
  toolResult,
  toolMetadata,
}: ToolRendererProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const config = getToolConfig(toolName);
  const labelContent = config.content(toolInput);
  const sc = stateConfigs[state] ?? stateConfigs.pending;

  const lower = toolName.toLowerCase();
  const isBash = lower === 'bash';
  const isFileTool = ['read', 'write', 'edit', 'update', 'notebookedit', 'multiedit'].includes(lower);
  const isWrite = lower === 'write';
  const writeStats = isWrite && toolMetadata
    ? `${toolMetadata.addedLines ?? 0} added, ${toolMetadata.removedLines ?? 0} removed`
    : undefined;
  const writeContent = typeof toolInput.content === 'string' ? toolInput.content : '';

  const filePath =
    (toolInput.file_path as string) ||
    (toolInput.notebook_path as string) ||
    (toolInput.path as string) ||
    '';

  const handleCopy = (key: string, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }).catch(() => {});
  };

  const copyBtn = (key: string, content: string) => (
    <button
      type="button"
      className="p-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] rounded-[var(--radius-xs)] transition-colors"
      onClick={(e) => { e.stopPropagation(); handleCopy(key, content); }}
      title="Copy"
    >
      {copiedKey === key ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className=""
    >
      {/* Compact header row */}
      <motion.button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 py-1 text-xs cursor-pointer transition-colors duration-100 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] w-full text-left"
      >
        <motion.span
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
          className="flex-shrink-0"
        >
          <ChevronRight size={10} className="text-[var(--color-text-tertiary)]" />
        </motion.span>
        <span className="min-w-0 flex items-center gap-1 overflow-hidden whitespace-nowrap">
          <span className="font-medium text-[var(--color-text-primary)] flex-shrink-0">
            {config.name}
          </span>
          {labelContent && (
            <span className="text-[var(--color-text-secondary)] overflow-hidden text-ellipsis">
              ({labelContent})
            </span>
          )}
        </span>
        <span className="flex-1" />
        <span className={`flex items-center gap-1 text-[11px] font-medium flex-shrink-0 ${
          sc.className === 'pending' ? 'text-[var(--color-text-tertiary)]' :
          sc.className === 'executing' ? 'text-[var(--color-info)]' :
          sc.className === 'done' ? 'text-[var(--color-success)]' :
          'text-[var(--color-danger)]'
        }`}>
          {sc.icon}
          <span>{sc.label}</span>
        </span>
      </motion.button>

      {/* Expanded detail */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="pl-6 pb-2 space-y-2">
              {/* Input: bash shows the command; file tools show the path */}
              {isBash ? (
                toolInput.command != null ? (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                        Command
                      </div>
                      {copyBtn('command', String(toolInput.command))}
                    </div>
                    <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-primary)] font-mono whitespace-pre-wrap break-all leading-[18px] m-0 max-h-48 overflow-y-auto">
                      {String(toolInput.command)}
                    </pre>
                  </div>
                ) : (
                  <KeyValueList input={toolInput} />
                )
              ) : isFileTool && filePath ? (
                <div className="text-xs font-mono text-[var(--color-info)] break-all">
                  {filePath}
                </div>
              ) : Object.keys(toolInput).length > 0 ? (
                <KeyValueList input={toolInput} />
              ) : null}

              {/* Write stats + content */}
              {isWrite && writeStats && (
                <div className="text-xs text-[var(--color-text-secondary)]">
                  {writeStats}
                </div>
              )}
              {isWrite && writeContent && (
                <div className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                  {writeContent}
                </div>
              )}

              {/* Tool result */}
              {!isWrite && toolResult != null && toolResult !== '' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                      Result
                    </div>
                    {copyBtn('result', toolResult)}
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

ToolRenderer.displayName = 'ToolRenderer';
