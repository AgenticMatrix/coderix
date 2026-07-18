import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText, FileEdit, FilePlus, Terminal, Search, Globe,
  FolderSearch, CheckSquare, Clock, AlertTriangle, Brain,
  Network, Users, UserPlus, UserMinus, BookOpen, MessageSquare,
  GitBranch, FileCode, Play, Wrench, ChevronRight, CheckCircle2,
  XCircle, Loader2, ExternalLink, FolderSync,
} from 'lucide-react';
import type { StreamBlock } from '../../types';

// ── Tool Display Config ────────────────────────────────────

interface ToolDisplayConfig {
  icon: React.ReactNode;
  label: (input: Record<string, unknown>) => string;
  detail?: (input: Record<string, unknown>) => string;
}

const toolConfigs: Record<string, ToolDisplayConfig> = {
  read: {
    icon: <FileText size={13} />,
    label: (input) => {
      const fp = input.file_path as string ?? '';
      return `Read ${truncatePath(fp)}`;
    },
  },
  write: {
    icon: <FilePlus size={13} />,
    label: (input) => {
      const fp = input.file_path as string ?? '';
      return `Write ${truncatePath(fp)}`;
    },
  },
  update: {
    icon: <FileEdit size={13} />,
    label: (input) => {
      const fp = input.file_path as string ?? '';
      return `Update ${truncatePath(fp)}`;
    },
  },
  bash: {
    icon: <Terminal size={13} />,
    label: (input) => {
      const desc = input.description as string ?? '';
      const cmd = input.command as string ?? '';
      return desc || cmd ? `Bash ${truncateText(desc || cmd, 60)}` : 'Bash';
    },
  },
  glob: {
    icon: <FolderSearch size={13} />,
    label: (input) => {
      const p = input.pattern as string ?? '';
      return `Glob ${truncateText(p, 60)}`;
    },
  },
  grep: {
    icon: <Search size={13} />,
    label: (input) => {
      const p = input.pattern as string ?? '';
      return `Grep ${truncateText(p, 60)}`;
    },
  },
  WebFetch: {
    icon: <Globe size={13} />,
    label: (input) => {
      const url = input.url as string ?? '';
      return `WebFetch ${truncateText(url, 50)}`;
    },
  },
  WebSearch: {
    icon: <ExternalLink size={13} />,
    label: (input) => {
      const q = input.query as string ?? '';
      return `WebSearch "${truncateText(q, 40)}"`;
    },
  },
  TaskCreate: {
    icon: <CheckSquare size={13} />,
    label: (input) => {
      const s = input.subject as string ?? input.description as string ?? '';
      return `TaskCreate ${truncateText(s, 60)}`;
    },
  },
  TaskUpdate: {
    icon: <CheckSquare size={13} />,
    label: (input) => {
      const id = input.taskId as string ?? '';
      return `TaskUpdate ${id}`;
    },
  },
  TaskList: {
    icon: <CheckSquare size={13} />,
    label: () => 'TaskList',
  },
  TaskGet: {
    icon: <CheckSquare size={13} />,
    label: (input) => {
      const id = input.taskId as string ?? '';
      return `TaskGet ${id}`;
    },
  },
  TaskOutput: {
    icon: <CheckSquare size={13} />,
    label: (input) => {
      const id = input.task_id as string ?? '';
      return `TaskOutput ${id}`;
    },
  },
  TaskStop: {
    icon: <CheckSquare size={13} />,
    label: (input) => {
      const id = input.task_id as string ?? '';
      return `TaskStop ${id}`;
    },
  },
  TodoWrite: {
    icon: <CheckSquare size={13} />,
    label: () => 'TodoWrite',
  },
  skill: {
    icon: <BookOpen size={13} />,
    label: (input) => {
      const s = input.skill as string ?? '';
      return `Skill ${s}`;
    },
  },
  AskUserQuestion: {
    icon: <MessageSquare size={13} />,
    label: (input) => {
      const questions = input.questions as Array<{ question: string }> ?? [];
      const q = questions[0]?.question ?? '';
      return `Ask ${truncateText(q, 50)}`;
    },
  },
  EnterPlanMode: {
    icon: <Brain size={13} />,
    label: () => 'Enter Plan Mode',
  },
  ExitPlanMode: {
    icon: <Brain size={13} />,
    label: () => 'Exit Plan Mode',
  },
  NotebookEdit: {
    icon: <FileCode size={13} />,
    label: (input) => {
      const fp = input.notebook_path as string ?? '';
      return `NotebookEdit ${truncatePath(fp)}`;
    },
  },
  Agent: {
    icon: <Network size={13} />,
    label: (input) => {
      const desc = input.description as string ?? input.prompt as string ?? '';
      return `Agent ${truncateText(desc, 50)}`;
    },
  },
  SendMessage: {
    icon: <Users size={13} />,
    label: (input) => {
      const to = input.to as string ?? '';
      return `SendMessage → ${to}`;
    },
  },
  TeamCreate: {
    icon: <UserPlus size={13} />,
    label: (input) => {
      const name = input.name as string ?? '';
      return `TeamCreate ${name}`;
    },
  },
  TeamDelete: {
    icon: <UserMinus size={13} />,
    label: (input) => {
      const name = input.name as string ?? '';
      return `TeamDelete ${name}`;
    },
  },
  Listen: {
    icon: <Clock size={13} />,
    label: (input) => {
      const d = input.duration as string ?? '';
      return `Listen ${d}`;
    },
  },
  EnterWorktree: {
    icon: <GitBranch size={13} />,
    label: (input) => {
      const name = input.name as string ?? input.path as string ?? '';
      return name ? `EnterWorktree ${name}` : 'EnterWorktree';
    },
  },
  ExitWorktree: {
    icon: <FolderSync size={13} />,
    label: (input) => {
      const action = input.action as string ?? '';
      return `ExitWorktree ${action}`;
    },
  },
  workflow: {
    icon: <Play size={13} />,
    label: (input) => {
      const name = input.name as string ?? '';
      return `Workflow ${name}`;
    },
  },
};

function getToolConfig(toolName: string): ToolDisplayConfig {
  return toolConfigs[toolName] ?? {
    icon: <Wrench size={13} />,
    label: () => toolName,
  };
}

// ── Helpers ────────────────────────────────────────────────

function truncatePath(path: string, maxLen = 80): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return path.slice(0, maxLen) + '…';
  const first = parts[0] || '';
  const last = parts[parts.length - 1] || '';
  const mid = `/${parts.slice(1, -1).map(p => p[0] || '').join('/')}/`;
  const result = `${first}${mid}${last}`;
  if (result.length <= maxLen) return result;
  return `…/${last}`;
}

function truncateText(text: string, maxLen = 80): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── State Config ───────────────────────────────────────────

interface StateConfig {
  icon: React.ReactNode;
  color: string;
}

const stateConfigs: Record<string, StateConfig> = {
  pending: { icon: <Clock size={12} />, color: 'var(--color-text-tertiary)' },
  executing: { icon: <Loader2 size={12} className="animate-spin" />, color: 'var(--color-info)' },
  done: { icon: <CheckCircle2 size={12} />, color: 'var(--color-success)' },
  error: { icon: <XCircle size={12} />, color: 'var(--color-danger)' },
};

// ── Component ──────────────────────────────────────────────

export interface ToolRendererProps {
  toolName: string;
  toolInput?: Record<string, unknown>;
  state?: StreamBlock['state'];
  toolId?: string;
}

export function ToolRenderer({
  toolName,
  toolInput = {},
  state = 'executing',
  toolId,
}: ToolRendererProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const config = getToolConfig(toolName);
  const sc = stateConfigs[state] ?? stateConfigs.pending;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="my-1"
    >
      {/* Compact header row */}
      <motion.button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 py-1 text-xs cursor-pointer transition-colors duration-100 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] w-full text-left"
      >
        <motion.span
          animate={{ rotate: isExpanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
        >
          <ChevronRight size={10} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
        </motion.span>
        <span style={{ color: sc.color }} className="flex-shrink-0">
          {sc.icon}
        </span>
        <span className="flex-shrink-0" style={{ color: sc.color }}>
          {config.icon}
        </span>
        <span className="font-medium text-[var(--color-text-primary)]">
          {config.label(toolInput)}
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
            <div className="pl-7 pb-2 space-y-1.5">
              {/* Tool input parameters */}
              {Object.keys(toolInput).length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)] mb-1">
                    Input
                  </div>
                  <div className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs font-mono">
                    {Object.entries(toolInput).map(([key, value]) => (
                      <div key={key} className="flex gap-2 py-0.5">
                        <span className="text-[var(--color-info)] flex-shrink-0">{key}:</span>
                        <span className="text-[var(--color-text-secondary)] break-all">
                          {truncateParamValue(value)}
                        </span>
                      </div>
                    ))}
                  </div>
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

function truncateParamValue(value: unknown, maxLen = 120): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}
