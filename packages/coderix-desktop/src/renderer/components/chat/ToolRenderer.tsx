import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Clock, CheckCircle2, XCircle, Loader2, Copy, Check, Wrench,
  Terminal, FileText, Search, Globe, Pencil, ListChecks, Sparkles, HelpCircle, GitBranch,
  Circle, Eye, Square, Info, RefreshCw, SquarePlus, ClipboardList,
  Map as MapIcon, LogOut, ChevronRight,
} from 'lucide-react';
import type { StreamBlock } from '../../types';
import { useT, type TranslationKey } from '../../i18n/index.js';
import { AgentToolCallCard } from './AgentToolCallCard';

type TFn = (key: TranslationKey, params?: Record<string, string | number>) => string;

// ── Tool Display Config ────────────────────────────────────
// Each tool gets a display name + a `content` builder so the collapsed
// header reads naturally, e.g. "List apps directory", "读取 src/app.ts".

interface ToolDisplayConfig {
  name: string;
  content: (input: Record<string, unknown>, t: TFn) => string;
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

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** 中文枚举：A、B 和 C（顿号分隔，最后一项用「和」连接）。 */
function joinHeaders(headers: string[]): string {
  if (headers.length <= 1) return headers[0] ?? '';
  return `${headers.slice(0, -1).join('、')} 和 ${headers[headers.length - 1]}`;
}

const toolConfigs: Record<string, ToolDisplayConfig> = {
  read: {
    name: 'Read',
    content: (i) => basename((i.file_path as string) || (i.path as string) || ''),
  },
  write: {
    name: 'Write',
    content: (i) => basename((i.file_path as string) || (i.path as string) || ''),
  },
  update: {
    name: 'Update',
    content: (i) => basename((i.file_path as string) || (i.path as string) || ''),
  },
  edit: {
    name: 'Edit',
    content: (i) => basename((i.file_path as string) || (i.path as string) || ''),
  },
  multiedit: {
    name: 'MultiEdit',
    content: (i) => {
      const edits = i.edits as Array<Record<string, unknown>> | undefined;
      const n = edits?.length ?? 0;
      return n ? `${n} files` : '';
    },
  },
  notebookedit: {
    name: 'NotebookEdit',
    content: (i) => truncatePath((i.notebook_path as string) || (i.file_path as string) || ''),
  },
  bash: {
    name: 'Bash',
    content: (i) => truncate((i.description as string) || (i.command as string) || '', 60),
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
  task: {
    name: 'Task',
    content: (i) => truncate((i.description as string) || '', 50),
  },
  taskcreate: {
    name: 'TaskCreate',
    content: (i) => {
      const s = (i.subject as string) || (i.activeForm as string) || '';
      return truncate(s, 50);
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
    content: (i, t) => {
      const todos = i.newTodos || i.todos;
      const n = Array.isArray(todos) ? todos.length : 0;
      return n ? t('tool.nItems', { n }) : '';
    },
  },
  skill: {
    name: 'Skill',
    content: (i) => truncate((i.skill as string) || (i.command as string) || '', 40),
  },
  askuserquestion: {
    name: 'Ask',
    content: (i) => {
      const qs = i.questions as Array<{ header?: string }> | undefined;
      const headers = (qs ?? []).map((q) => q.header).filter((h): h is string => !!h);
      return headers.length ? truncate(joinHeaders(headers), 60) : '';
    },
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
  enterplanmode: {
    name: 'Enter Plan Mode',
    content: () => '',
  },
  exitplanmode: {
    name: 'Exit Plan Mode',
    content: () => '',
  },
  ls: {
    name: 'LS',
    content: (i) => truncatePath((i.path as string) || ''),
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

const TOOL_LABEL: Record<string, string> = {
  read: '读取',
  write: '创建文件',
  update: '编辑',
  edit: '编辑',
  multiedit: '编辑',
  notebookedit: '编辑',
  bash: '终端',
  glob: '搜索文件',
  grep: '搜索内容',
  webfetch: '获取网页内容',
  websearch: '网页搜索',
  task: '委派任务',
  taskcreate: '创建任务',
  taskupdate: '更新任务',
  tasklist: '查看任务清单',
  taskget: '获取任务',
  taskoutput: '查看任务 ID',
  taskstop: '终止任务',
  todowrite: '刷新任务清单',
  skill: '技能',
  askuserquestion: '询问',
  agent: '智能体',
  sendmessage: '发送消息',
  teamcreate: '创建团队',
  teamdelete: '删除团队',
  listen: '监听',
  enterplanmode: '进入计划模式',
  exitplanmode: '退出计划模式',
  ls: '列出',
  enterworktree: '进入工作树',
  exitworktree: '退出工作树',
  workflow: '工作流',
};

function getToolConfig(toolName: string): ToolDisplayConfig {
  const lower = toolName.toLowerCase();
  const base = toolConfigs[lower] ?? {
    name: toolName,
    content: () => '',
  };
  return { name: TOOL_LABEL[lower] ?? base.name, content: base.content };
}

const ICON_SIZE = 13;

/** Per-tool-category icon (falls back to a generic wrench). */
function getToolIcon(toolName: string): React.ReactNode {
  const lower = toolName.toLowerCase();
  switch (lower) {
    case 'bash':
      return <Terminal size={ICON_SIZE} />;
    case 'read':
      return <FileText size={ICON_SIZE} />;
    case 'glob':
    case 'grep':
    case 'websearch':
      return <Search size={ICON_SIZE} />;
    case 'webfetch':
      return <Globe size={ICON_SIZE} />;
    case 'write':
    case 'update':
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return <Pencil size={ICON_SIZE} />;
    case 'todowrite':
      return <ListChecks size={ICON_SIZE} />;
    case 'taskcreate':
      return <SquarePlus size={ICON_SIZE} />;
    case 'taskupdate':
      return <RefreshCw size={ICON_SIZE} />;
    case 'tasklist':
      return <ClipboardList size={ICON_SIZE} />;
    case 'taskget':
      return <Info size={ICON_SIZE} />;
    case 'taskoutput':
      return <Eye size={ICON_SIZE} />;
    case 'taskstop':
      return <Square size={ICON_SIZE} />;
    case 'enterplanmode':
      return <MapIcon size={ICON_SIZE} />;
    case 'exitplanmode':
      return <LogOut size={ICON_SIZE} />;
    case 'skill':
      return <Sparkles size={ICON_SIZE} />;
    case 'askuserquestion':
      return <HelpCircle size={ICON_SIZE} />;
    case 'enterworktree':
    case 'exitworktree':
      return <GitBranch size={ICON_SIZE} />;
    default:
      return <Wrench size={ICON_SIZE} />;
  }
}

// ── Collapsed header label ─────────────────────────────────
// Mirrors agentstation's collapsed header: bash shows its `description`
// directly ("List apps directory"), file tools read "读取 app.ts", search and
// task tools use a colon ("搜索文件: pattern"). `name` is empty for bash so
// only the description renders.

interface ToolHeaderParts {
  name: string;
  sep: string;
  content: string;
}

function formatToolHeader(lower: string, name: string, content: string): ToolHeaderParts {
  switch (lower) {
    case 'bash':
      // Just the description, no tool name or parentheses.
      return content ? { name: '', sep: '', content } : { name, sep: '', content: '' };
    case 'read':
    case 'write':
    case 'edit':
    case 'update':
    case 'todowrite':
    case 'askuserquestion':
      return { name, sep: content ? ' ' : '', content };
    case 'glob':
    case 'grep':
    case 'webfetch':
    case 'websearch':
    case 'taskget':
    case 'taskoutput':
    case 'taskstop':
    case 'taskcreate':
      return { name, sep: content ? ': ' : '', content };
    case 'taskupdate':
      return { name, sep: content ? ' ' : '', content: content ? `#${content}` : '' };
    default:
      return { name, sep: content ? ' ' : '', content: content ? `(${content})` : '' };
  }
}

// ── State Config ───────────────────────────────────────────

interface StateConfig {
  icon: React.ReactNode;
  className: string;
  labelKey: TranslationKey;
}

const stateConfigs: Record<string, StateConfig> = {
  pending: { icon: <Clock size={12} />, className: 'pending', labelKey: 'tool.pending' },
  executing: { icon: <Loader2 size={12} className="animate-spin" />, className: 'executing', labelKey: 'tool.running' },
  done: { icon: <CheckCircle2 size={12} />, className: 'done', labelKey: 'tool.done' },
  error: { icon: <XCircle size={12} />, className: 'error', labelKey: 'tool.error' },
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
  /** Force-open (search reveal) regardless of the collapsed preference. */
  reveal?: boolean;
}

export function ToolRenderer({
  toolName,
  toolInput = {},
  state = 'executing',
  toolId,
  toolResult,
  toolMetadata,
  reveal = false,
}: ToolRendererProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const t = useT();
  const expanded = isExpanded || reveal;

  // The `Agent` tool spawns a sub-agent — render it as a dedicated ZCode-style
  // summary card (bot icon + colored agent type + description + lifecycle)
  // rather than the generic tool card below.
  if (toolName.toLowerCase() === 'agent') {
    return (
      <AgentToolCallCard
        toolInput={toolInput}
        state={state}
        toolId={toolId}
        toolResult={toolResult}
        toolMetadata={toolMetadata}
      />
    );
  }

  const config = getToolConfig(toolName);
  const labelContent = config.content(toolInput, t);
  const sc = stateConfigs[state] ?? stateConfigs.pending;

  const lower = toolName.toLowerCase();
  const header = formatToolHeader(lower, config.name, labelContent);
  const isBash = lower === 'bash';
  const isWrite = lower === 'write';
  const isRead = lower === 'read';
  const isGlob = lower === 'glob';
  const isGrep = lower === 'grep';
  const isEdit = lower === 'edit' || lower === 'update';
  const isWebSearch = lower === 'websearch';
  const isWebFetch = lower === 'webfetch';
  const isAsk = lower === 'askuserquestion';
  const isTodo = lower === 'todowrite';
  const isTaskCreate = lower === 'taskcreate';
  const isTaskUpdate = lower === 'taskupdate';
  const isEnterPlanMode = lower === 'enterplanmode';
  const isExitPlanMode = lower === 'exitplanmode';
  const isFileTool = ['read', 'write', 'edit', 'update', 'notebookedit', 'multiedit'].includes(lower);
  const isError = state === 'error';

  const handleCopy = (key: string, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }).catch(() => {});
  };

  const copyBtn = (key: string, content: string) => (
    <button
      type="button"
      className="inline-flex items-center justify-center p-0.5 rounded-[var(--radius-xs)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors flex-shrink-0"
      onClick={(e) => { e.stopPropagation(); handleCopy(key, content); }}
      title={t('tool.copy')}
    >
      {copiedKey === key ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );

  const sectionHeader = (title: string, copyKey: string, copyValue: string) => (
    <div className="flex items-center justify-between gap-2 mb-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
        {title}
      </div>
      {copyBtn(copyKey, copyValue)}
    </div>
  );

  const filePath =
    (toolInput.file_path as string) ||
    (toolInput.notebook_path as string) ||
    (toolInput.path as string) ||
    '';
  const writeContent = typeof toolInput.content === 'string' ? toolInput.content : '';
  const oldString = toolInput.old_string as string | undefined;
  const newString = toolInput.new_string as string | undefined;
  const prompt = toolInput.prompt as string | undefined;
  const taskSubject = (toolInput.subject as string) || (toolInput.activeForm as string) || '';
  const taskDescription = toolInput.description as string || '';
  const taskUpdateSubject = (toolMetadata?.subject as string) || taskSubject || '';
  const oldStatus = toolMetadata?.oldStatus as string | undefined;
  const newStatus = toolMetadata?.status as string | undefined;
  const planContent = toolMetadata?.plan as string | undefined;
  const writeStats = isWrite && toolMetadata
    ? t('tool.addedRemoved', { added: Number(toolMetadata.addedLines ?? 0), removed: Number(toolMetadata.removedLines ?? 0) })
    : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
    >
      {/* Compact header row */}
      <motion.button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 py-1 text-xs cursor-pointer transition-colors duration-100 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] w-full text-left"
      >
        <span className="min-w-0 flex items-center gap-1 overflow-hidden whitespace-nowrap">
          <span className="text-[var(--color-text-tertiary)] flex-shrink-0">
            {getToolIcon(toolName)}
          </span>
          {header.name && (
            <span className="text-[var(--color-text-primary)] flex-shrink-0">
              {header.name}{header.sep}
            </span>
          )}
          {header.content && (
            <span className="text-[var(--color-text-secondary)] overflow-hidden text-ellipsis">
              {header.content}
            </span>
          )}
        </span>
        <ChevronRight
          size={11}
          className={`text-[var(--color-text-tertiary)] flex-shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="flex-1" />
        <span className={`flex items-center gap-1 text-[11px] font-medium flex-shrink-0 ${
          sc.className === 'pending' ? 'text-[var(--color-text-tertiary)]' :
          sc.className === 'executing' ? 'text-[var(--color-info)]' :
          sc.className === 'done' ? 'text-[var(--color-success)]' :
          'text-[var(--color-danger)]'
        }`}>
          {sc.icon}
          <span>{t(sc.labelKey)}</span>
        </span>
      </motion.button>

      {/* Expanded detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="pl-6 pb-2 space-y-2">
              {/* ── Per-tool input body ── */}
              {isBash ? (
                toolInput.command != null ? (
                  <div>
                    {sectionHeader(t('tool.command'), 'command', String(toolInput.command))}
                    <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-primary)] font-mono whitespace-pre-wrap break-all leading-[18px] m-0 max-h-48 overflow-y-auto">
                      {String(toolInput.command)}
                    </pre>
                  </div>
                ) : (
                  <KeyValueList input={toolInput} />
                )
              ) : isWrite ? (
                <>
                  {filePath && (
                    <PathBoxSection title={t('tool.filePath')} copyKey="filePath" value={filePath} copiedKey={copiedKey} onCopy={handleCopy} />
                  )}
                  {writeStats && (
                    <div className="text-xs text-[var(--color-text-secondary)]">{writeStats}</div>
                  )}
                  {writeContent !== '' && (
                    <DiffSection oldText="" newText={writeContent} copiedKey={copiedKey} onCopy={handleCopy} />
                  )}
                </>
              ) : isEdit ? (
                <>
                  {filePath && (
                    <PathBoxSection title={t('tool.filePath')} copyKey="filePath" value={filePath} copiedKey={copiedKey} onCopy={handleCopy} />
                  )}
                  {newString != null && (
                    <DiffSection oldText={oldString ?? ''} newText={newString} copiedKey={copiedKey} onCopy={handleCopy} />
                  )}
                </>
              ) : isRead ? (
                filePath ? (
                  <PathBoxSection title={t('tool.filePath')} copyKey="filePath" value={filePath} copiedKey={copiedKey} onCopy={handleCopy} />
                ) : null
              ) : isGrep ? (
                filePath ? (
                  <PathBoxSection title={t('tool.searchScope')} copyKey="searchScope" value={filePath} copiedKey={copiedKey} onCopy={handleCopy} />
                ) : null
              ) : isGlob ? (
                null
              ) : isWebFetch ? (
                prompt != null && prompt !== '' ? (
                  <div>
                    {sectionHeader(t('tool.prompt'), 'prompt', String(prompt))}
                    <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-primary)] font-mono whitespace-pre-wrap break-all leading-[18px] m-0 max-h-48 overflow-y-auto">
                      {String(prompt)}
                    </pre>
                  </div>
                ) : null
              ) : isWebSearch ? (
                null
              ) : isTodo ? (
                <TodoInput input={toolInput} />
              ) : isAsk ? (
                <AskQuestionsInput input={toolInput} answers={toolMetadata?.answers as Record<string, unknown> | undefined} />
              ) : isTaskCreate ? (
                <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
                  <li className="text-xs text-[var(--color-text-secondary)] leading-relaxed flex items-baseline gap-1.5">
                    <span className="flex-shrink-0 text-[var(--color-text-tertiary)]">○</span>
                    <span>
                      {taskSubject}
                      {taskDescription ? `: ${taskDescription}` : ''}
                    </span>
                  </li>
                </ul>
              ) : isTaskUpdate ? (
                (oldStatus || newStatus) ? (
                  <div className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] py-0.5">
                    {formatTaskStatus(oldStatus, t)}
                    <span className="text-[var(--color-text-tertiary)]">→</span>
                    {formatTaskStatus(newStatus, t)}
                    {taskUpdateSubject ? <span className="text-[var(--color-text-tertiary)]">({taskUpdateSubject})</span> : null}
                  </div>
                ) : null
              ) : isEnterPlanMode ? (
                null
              ) : isExitPlanMode ? (
                (planContent || toolResult) ? (
                  <div>
                    {sectionHeader(t('tool.result'), 'plan', planContent || toolResult || '')}
                    <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-secondary)] font-mono whitespace-pre-wrap break-words leading-[18px] m-0 max-h-48 overflow-y-auto">
                      {planContent || toolResult}
                    </pre>
                  </div>
                ) : null
              ) : isFileTool && filePath ? (
                <div className="text-xs font-mono text-[var(--color-info)] break-all">
                  {filePath}
                </div>
              ) : Object.keys(toolInput).length > 0 ? (
                <KeyValueList input={toolInput} />
              ) : null}

              {/* ── Tool result — every tool shows its output, so input and
                  output stay paired in one card (write/edit/ask/task transitions
                  render their own result inline above). ── */}
              {!isWrite && !isEdit && !isAsk && !isTaskCreate && !isTaskUpdate && !isExitPlanMode && toolResult != null && toolResult !== '' && (
                <div>
                  {sectionHeader(t('tool.result'), 'result', toolResult)}
                  <pre className={`p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs font-mono whitespace-pre-wrap break-words leading-[18px] m-0 max-h-48 overflow-y-auto ${isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'}`}>
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

// ── Sections ───────────────────────────────────────────────

function PathBoxSection({ title, copyKey, value, copiedKey, onCopy }: {
  title: string;
  copyKey: string;
  value: string;
  copiedKey: string | null;
  onCopy: (key: string, content: string) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          {title}
        </div>
        <button
          type="button"
          className="inline-flex items-center justify-center p-0.5 rounded-[var(--radius-xs)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors flex-shrink-0"
          onClick={() => onCopy(copyKey, value)}
          title={t('tool.copy')}
        >
          {copiedKey === copyKey ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-info)] font-mono whitespace-pre-wrap break-all leading-[18px] m-0">
        {value}
      </pre>
    </>
  );
}

// ── Diff rendering (edit/write before → after) ────────────

type DiffLineType = 'add' | 'del' | 'context';

interface DiffLine {
  type: DiffLineType;
  text: string;
}

function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'context', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: a[i] });
      i++;
    } else {
      lines.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) lines.push({ type: 'del', text: a[i++] });
  while (j < m) lines.push({ type: 'add', text: b[j++] });
  return lines;
}

function diffText(oldText: string, newText: string): string {
  return diffLines(oldText, newText)
    .map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`)
    .join('\n');
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = diffLines(oldText, newText);
  let oldNum = 0;
  let newNum = 0;
  const annotated = lines.map((line) => {
    let num: number | null = null;
    if (line.type === 'context') {
      oldNum++;
      newNum++;
      num = newNum;
    } else if (line.type === 'del') {
      oldNum++;
      num = oldNum;
    } else {
      newNum++;
      num = newNum;
    }
    return { ...line, num };
  });
  const numWidth = `${Math.max(1, ...annotated.map((l) => l.num ?? 0)).toString().length}ch`;
  return (
    <pre className="m-0 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] font-mono text-xs leading-[1.5] overflow-x-auto overflow-y-auto max-h-60">
      {annotated.map((line, i) => (
        <div
          key={i}
          className={`flex gap-2 px-2.5 ${
            line.type === 'add'
              ? 'bg-[var(--color-success-muted)] text-[var(--color-success)]'
              : line.type === 'del'
                ? 'bg-[var(--color-danger-muted)] text-[var(--color-danger)]'
                : 'text-[var(--color-text-secondary)]'
          }`}
        >
          <span className="flex-shrink-0 text-right text-[var(--color-text-tertiary)] select-none" style={{ width: numWidth }}>
            {line.num ?? ''}
          </span>
          <span className="flex-shrink-0 w-3 text-center select-none">
            {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
          </span>
          <span className="flex-1 min-w-0 whitespace-pre-wrap break-all">{line.text || ' '}</span>
        </div>
      ))}
    </pre>
  );
}

function DiffSection({ oldText, newText, copiedKey, onCopy }: {
  oldText: string;
  newText: string;
  copiedKey: string | null;
  onCopy: (key: string, content: string) => void;
}) {
  const t = useT();
  const text = diffText(oldText, newText);
  return (
    <>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          {t('tool.diff')}
        </div>
        <button
          type="button"
          className="inline-flex items-center justify-center p-0.5 rounded-[var(--radius-xs)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)] transition-colors flex-shrink-0"
          onClick={() => onCopy('diff', text)}
          title={t('tool.copy')}
        >
          {copiedKey === 'diff' ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <DiffView oldText={oldText} newText={newText} />
    </>
  );
}

// ── Todo list ─────────────────────────────────────────────

function TodoInput({ input }: { input: Record<string, unknown> }) {
  const todos = (input.newTodos || input.todos) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(todos) || todos.length === 0) {
    return <KeyValueList input={input} />;
  }
  return (
    <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
      {todos.map((todo, i) => {
        const done = todo.status === 'completed';
        const text = (todo.content as string) || (todo.text as string) || String(i);
        return (
          <li key={`${text}-${i}`} className={`text-xs leading-relaxed flex items-baseline gap-1.5 ${done ? 'text-[var(--color-text-tertiary)] line-through' : 'text-[var(--color-text-secondary)]'}`}>
            <span className={`flex-shrink-0 ${done ? 'text-[var(--color-success)]' : 'text-[var(--color-text-tertiary)]'}`}>
              {done ? '✓' : '○'}
            </span>
            <span>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ── Ask questions ─────────────────────────────────────────

function AskQuestionsInput({ input, answers }: { input: Record<string, unknown>; answers?: Record<string, unknown> }) {
  const questions = input.questions as Array<{ question?: string; options?: Array<{ label?: string }> }> | undefined;
  if (!Array.isArray(questions) || questions.length === 0) {
    return <KeyValueList input={input} />;
  }

  // `metadata.answers` is keyed by question text; a value is either an array of
  // selected labels or a comma-joined string (multi-select).
  const selectedFor = (question: string): string[] => {
    const raw = answers?.[question];
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
  };

  return (
    <div className="flex flex-col gap-2">
      {questions.map((q, qi) => {
        const selected = selectedFor(q.question ?? '');
        return (
          <div key={qi}>
            <div className="text-xs font-semibold text-[var(--color-text-primary)] mb-1">{q.question}</div>
            <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
              {(q.options ?? []).map((opt, oi) => {
                const label = opt.label ?? '';
                const isSelected = selected.includes(label);
                return (
                  <li key={oi} className="flex items-center gap-1.5 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                    <span className={`flex-shrink-0 inline-flex items-center justify-center w-3.5 ${isSelected ? 'text-[var(--color-success)]' : 'text-[var(--color-text-tertiary)]'}`}>
                      {isSelected ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                    </span>
                    <span className={isSelected ? 'text-[var(--color-text-primary)]' : ''}>{label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ── Task status transition ────────────────────────────────

const TASK_STATUS_KEYS: Record<string, TranslationKey> = {
  pending: 'tool.status.pending',
  in_progress: 'tool.status.in_progress',
  completed: 'tool.status.completed',
  deleted: 'tool.status.deleted',
};

function formatTaskStatus(status: string | undefined, t: TFn): string {
  if (!status) return '';
  return TASK_STATUS_KEYS[status] ? t(TASK_STATUS_KEYS[status]) : status;
}
