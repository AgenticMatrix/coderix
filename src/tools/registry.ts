import type Anthropic from '@anthropic-ai/sdk';

import type { ToolPlugin, ToolMeta, ToolExecutor, ToolUseRenderer, ToolResultRenderer, ToolResult, ExecutorOptions, ResolvedExecutorOptions } from './types.js';
import { GenericToolRenderer, GenericToolResultRenderer } from './base/GenericRenderer.js';

// ── Plugin imports (add new tools here) ────────────────────────────────
import bashPlugin from './bash/index.js';
import readPlugin from './read/index.js';
import writePlugin from './write/index.js';
import editPlugin from './edit/index.js';
import globPlugin from './glob/index.js';
import grepPlugin from './grep/index.js';
import webFetchPlugin from './web-fetch/index.js';
import webSearchPlugin from './web-search/index.js';
import todoWritePlugin from './todo-write/index.js';
import taskCreatePlugin from './task-create/index.js';
import taskUpdatePlugin from './task-update/index.js';
import taskListPlugin from './task-list/index.js';
import taskGetPlugin from './task-get/index.js';
import sleepPlugin from './sleep/index.js';
import agentSpawnPlugin from '../agents/agent-spawn/index.js';
import sendMessagePlugin from '../teams/tools/team-message/index.js';
import teamCreatePlugin from '../teams/tools/team-create/index.js';
import teamDeletePlugin from '../teams/tools/team-delete/index.js';
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

// ── Known tool names (for tools without executors yet) ─────────────────
const KNOWN_TOOL_NAMES: string[] = [
  'git', 'powershell',
  'task-describe',
  'cron-create', 'cron-delete', 'cron-list',
  'lsp',
];

// ── Plugin registration ────────────────────────────────────────────────

/** Core plugins loaded at startup. Skill-activated tools are in LAZY_PLUGINS. */
export const plugins: ToolPlugin[] = [
  bashPlugin,
  readPlugin,
  writePlugin,
  editPlugin,
  globPlugin,
  grepPlugin,
  webFetchPlugin,
  webSearchPlugin,
  todoWritePlugin,
  taskCreatePlugin,
  taskUpdatePlugin,
  taskListPlugin,
  taskGetPlugin,
  sleepPlugin,
  agentSpawnPlugin,
  sendMessagePlugin,
  teamCreatePlugin,
  teamDeletePlugin,
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

/** Map legacy kebab-case tool names to current canonical names. */
const TOOL_ALIASES: Record<string, string> = {
  'team-create': 'TeamCreate',
  'team-message': 'SendMessage',
  'team-dispatch': '',    // removed — use Agent tool instead
  'team-status': '',      // removed — use TaskGet/TaskList instead
  'Task': 'Agent',        // legacy Agent tool alias
};

function resolveName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

// Build lookup tables
const schemaByName = new Map<string, ToolPlugin['schema']>();
const executorByName = new Map<string, ToolExecutor>();
const useRendererByName = new Map<string, ToolUseRenderer>();
const resultRendererByName = new Map<string, ToolResultRenderer>();
const isEnabledByName = new Map<string, () => boolean>();

for (const p of plugins) {
  schemaByName.set(p.name, p.schema);
  executorByName.set(p.name, p.executor);
  if (p.useRenderer) useRendererByName.set(p.name, p.useRenderer);
  if (p.resultRenderer) resultRendererByName.set(p.name, p.resultRenderer);
  if (p.isEnabled) isEnabledByName.set(p.name, p.isEnabled);
}

// Pre-populate renderers for known (executor-less) tool names
for (const name of KNOWN_TOOL_NAMES) {
  useRendererByName.set(name, GenericToolRenderer);
  resultRendererByName.set(name, GenericToolResultRenderer);
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

/** Get tool metadata by name. */
export function getToolMeta(toolName: string): ToolMeta | undefined {
  return schemaByName.get(toolName)?._meta;
}

/** Get risk level for a tool by name, optionally considering command content. */
export function getToolRiskLevel(toolName: string, input?: Record<string, unknown>): ToolMeta['riskLevel'] {
  const meta = getToolMeta(toolName);
  const staticRisk = meta?.riskLevel ?? 'safe';

  // Dynamic override for bash commands based on classification
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

/** Remove the agent-message SendMessage alias (deprecated — use unified SendMessage). */
const REMOVED_TOOLS: Record<string, string> = {
  'team-dispatch': 'team-dispatch has been removed. Spawn teammates via the Agent tool with team_name + name parameters.',
  'team-status': 'team-status has been removed. Use TaskGet or TaskList to check agent statuses.',
};

/**
 * Execute a tool by name with the given input.
 * Returns a ToolResult with content and isError flag.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  options?: ExecutorOptions,
): Promise<ToolResult> {
  const resolvedName = resolveName(toolName);
  const opts: ResolvedExecutorOptions = { ...EXECUTOR_DEFAULTS, ...options };

  // Handle removed tools (check original name before alias resolution)
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

/** Look up a tool-use renderer by name. Falls back to GenericToolRenderer. */
export function getToolUseRenderer(toolName: string): ToolUseRenderer {
  const resolved = resolveName(toolName);
  return useRendererByName.get(resolved) ?? GenericToolRenderer;
}

/** Look up a tool-result renderer by name. Falls back to GenericToolResultRenderer. */
export function getToolResultRenderer(toolName: string): ToolResultRenderer {
  const resolved = resolveName(toolName);
  return resultRendererByName.get(resolved) ?? GenericToolResultRenderer;
}
