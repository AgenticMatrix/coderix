import type Anthropic from '@anthropic-ai/sdk';

import type { ToolPlugin, ToolMeta, ToolExecutor, ToolResult, ExecutorOptions, ResolvedExecutorOptions } from './types.js';

// ── Plugin imports (add new tools here) ────────────────────────────────
import bashPlugin from './bash/index.js';
import readPlugin from './read/index.js';
import writePlugin from './write/index.js';
import updatePlugin from './update/index.js';
import globPlugin from './glob/index.js';
import grepPlugin from './grep/index.js';
import webFetchPlugin from './web-fetch/index.js';
import webSearchPlugin from './web-search/index.js';
import todoWritePlugin from './todo-write/index.js';
import taskCreatePlugin from './task-create/index.js';
import taskUpdatePlugin from './task-update/index.js';
import taskListPlugin from './task-list/index.js';
import taskGetPlugin from './task-get/index.js';
import listenPlugin from './listen/index.js';
import agentSpawnPlugin from '../agents/agent-spawn/index.js';
import sendMessagePlugin from '../teams/tools/team-message/index.js';
import teamCreatePlugin from '../teams/tools/team-create/index.js';
import teamDeletePlugin from '../teams/tools/team-delete/index.js';
import teamAgentPlugin from '../teams/tools/team-agent/index.js';
import taskOutputPlugin from './task-output/index.js';
import taskStopPlugin from './task-stop/index.js';
import skillPlugin from './skill/index.js';
import askUserQuestionPlugin from './ask-user-question/index.js';
import enterPlanModePlugin from './enter-plan-mode/index.js';
import exitPlanModePlugin from './exit-plan-mode/index.js';
import notebookEditPlugin from './notebook-edit/index.js';
import workflowPlugin from '../agents/workflow/index.js';
import enterWorktreePlugin from './enter-worktree/index.js';
import exitWorktreePlugin from './exit-worktree/index.js';

// ── Plugin registration ────────────────────────────────────────────────

/** Core plugins loaded at startup. UI renderers are registered separately by each frontend. */
export const plugins: ToolPlugin[] = [
  bashPlugin,
  readPlugin,
  writePlugin,
  updatePlugin,
  globPlugin,
  grepPlugin,
  webFetchPlugin,
  webSearchPlugin,
  todoWritePlugin,
  taskCreatePlugin,
  taskUpdatePlugin,
  taskListPlugin,
  taskGetPlugin,
  listenPlugin,
  agentSpawnPlugin,
  sendMessagePlugin,
  teamCreatePlugin,
  teamDeletePlugin,
  teamAgentPlugin,
  taskOutputPlugin,
  taskStopPlugin,
  skillPlugin,
  askUserQuestionPlugin,
  enterPlanModePlugin,
  exitPlanModePlugin,
  notebookEditPlugin,
  workflowPlugin,
  enterWorktreePlugin,
  exitWorktreePlugin,
];

// ── Backward-compatible aliases ───────────────────────────────────────

const TOOL_ALIASES: Record<string, string> = {
  'team-create': 'teamcreate',
  'team-message': 'sendmessage',
  'Task': 'agent',
  'edit': 'update',
};

function resolveName(name: string): string {
  const lower = name.toLowerCase();
  return TOOL_ALIASES[lower] ?? lower;
}

// Build lookup tables (keys are lowercased for case-insensitive matching)
const schemaByName = new Map<string, ToolPlugin['schema']>();
const executorByName = new Map<string, ToolExecutor>();
const isEnabledByName = new Map<string, () => boolean>();

for (const p of plugins) {
  const key = p.name.toLowerCase();
  schemaByName.set(key, p.schema);
  executorByName.set(key, p.executor);
  if (p.isEnabled) isEnabledByName.set(key, p.isEnabled);
}

// ── Public API ─────────────────────────────────────────────────────────

/** Extract pure Anthropic tool definitions (strip _meta, skip disabled). */
export function getAnthropicTools(): Anthropic.Tool[] {
  return Array.from(schemaByName.entries())
    .filter(([name]) => {
      const fn = isEnabledByName.get(name);
      return !fn || fn();
    })
    .map(([, schema]) => {
      const { _meta: _, ...tool } = schema;
      return tool;
    });
}

/** Get tool metadata by name (case-insensitive). */
export function getToolMeta(toolName: string): ToolMeta | undefined {
  return schemaByName.get(toolName.toLowerCase())?._meta;
}

/** Get risk level for a tool by name, optionally considering command content. */
export function getToolRiskLevel(toolName: string, input?: Record<string, unknown>): ToolMeta['riskLevel'] {
  const meta = getToolMeta(toolName);
  const staticRisk = meta?.riskLevel ?? 'safe';

  if (toolName === 'bash' && input?._classification) {
    const c = input._classification as { isReadOnly?: boolean; category?: string };
    if (c.isReadOnly) return 'safe';
    if (c.category === 'code_exec' || c.category === 'destructive') return 'destructive';
    if (c.category === 'network') return 'destructive';
  }

  return staticRisk;
}

const EXECUTOR_DEFAULTS: ResolvedExecutorOptions = {
  cwd: process.cwd(),
  allowMutation: true,
  maxOutput: 50_000,
  bashTimeout: 30_000,
  agentSpawn: undefined,
  setPermissionMode: undefined,
};

const REMOVED_TOOLS: Record<string, string> = {
  'team-dispatch': 'team-dispatch has been removed. Spawn teammates via the Agent tool with team_name + name parameters.',
  'team-status': 'team-status has been removed. Use TaskGet or TaskList to check agent statuses.',
};

/** Execute a tool by name with the given input. */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  options?: ExecutorOptions,
): Promise<ToolResult> {
  const resolvedName = resolveName(toolName);
  const opts: ResolvedExecutorOptions = { ...EXECUTOR_DEFAULTS, ...options };

  if (toolName in REMOVED_TOOLS) {
    return { content: REMOVED_TOOLS[toolName], isError: true };
  }

  const fn = executorByName.get(resolvedName);

  if (!fn) {
    return {
      content: `Unknown tool: ${resolvedName}. Available: ${[...executorByName.keys()].join(', ')}`,
      isError: true,
    };
  }

  const enabled = isEnabledByName.get(resolvedName);
  if (enabled && !enabled()) {
    return {
      content: `Tool ${resolvedName} is disabled in the current mode.`,
      isError: true,
    };
  }

  try {
    return await fn(input, opts);
  } catch (err) {
    return {
      content: `Tool execution error: ${(err as Error).message}`,
      isError: true,
    };
  }
}

/** Check if a tool name has an executor registered and is enabled. */
export function hasExecutor(toolName: string): boolean {
  if (toolName in REMOVED_TOOLS) return false;
  const resolved = resolveName(toolName);
  if (!executorByName.has(resolved)) return false;
  const enabled = isEnabledByName.get(resolved);
  return !enabled || enabled();
}

/** Get the interrupt behavior for a tool.
 *  Default: 'cancel' for safe tools, 'block' for mutation/destructive. */
export function getInterruptBehavior(toolName: string): 'cancel' | 'block' {
  const meta = getToolMeta(toolName);
  if (meta?.interruptBehavior) return meta.interruptBehavior;
  if (meta?.riskLevel === 'safe') return 'cancel';
  return 'block';
}
