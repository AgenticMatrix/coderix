/**
 * CLI Tool Registry
 *
 * Maps core tool plugins to Ink renderers for the TUI.
 * Core tools provide executor + schema; CLI provides the visual layer.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { plugins as corePlugins, getToolMeta, getToolRiskLevel, executeTool, hasExecutor } from '@coderix/core';

import type { ToolUseRenderer, ToolResultRenderer, ToolPlugin } from './types.js';
import { GenericToolRenderer, GenericToolResultRenderer } from './base/GenericRenderer.js';

// ── Tool-use renderers ──────────────────────────────────────────────────
import { BashRenderer } from './bash/renderer.js';
import { ReadRenderer } from './read/renderer.js';
import { WriteRenderer } from './write/renderer.js';
import { UpdateRenderer } from './update/renderer.js';
import { GlobRenderer } from './glob/renderer.js';
import { GrepRenderer } from './grep/renderer.js';
import { WebFetchRenderer } from './web-fetch/renderer.js';
import { WebSearchRenderer } from './web-search/renderer.js';
import { TodoWriteRenderer } from './todo-write/renderer.js';
import { TaskCreateRenderer } from './task-create/renderer.js';
import { TaskUpdateRenderer } from './task-update/renderer.js';
import { TaskListRenderer } from './task-list/renderer.js';
import { TaskGetRenderer } from './task-get/renderer.js';
import { TaskOutputRenderer } from './task-output/renderer.js';
import { TaskStopRenderer } from './task-stop/renderer.js';
import { SkillRenderer } from './skill/renderer.js';
import { AskUserQuestionRenderer } from './ask-user-question/renderer.js';
import { AskUserQuestionResultRenderer } from './ask-user-question/result-renderer.js';
import { EnterPlanModeRenderer } from './enter-plan-mode/renderer.js';
import { EnterPlanModeResultRenderer } from './enter-plan-mode/result-renderer.js';
import { ExitPlanModeRenderer } from './exit-plan-mode/renderer.js';
import { NotebookEditRenderer } from './notebook-edit/renderer.js';
import { AgentRenderer } from './agent/renderer.js';
import { SendMessageRenderer } from './send-message/renderer.js';

// ── Tool-result renderers ───────────────────────────────────────────────
import { BashResultRenderer } from './bash/result-renderer.js';
import { GlobResultRenderer } from './glob/result-renderer.js';
import { GrepResultRenderer } from './grep/result-renderer.js';
import { ReadResultRenderer } from './read/result-renderer.js';
import { SkillResultRenderer } from './skill/result-renderer.js';
import { TaskCreateResultRenderer } from './task-create/result-renderer.js';
import { TaskGetResultRenderer } from './task-get/result-renderer.js';
import { TaskListResultRenderer } from './task-list/result-renderer.js';
import { TaskOutputResultRenderer } from './task-output/result-renderer.js';
import { TaskStopResultRenderer } from './task-stop/result-renderer.js';
import { TaskUpdateResultRenderer } from './task-update/result-renderer.js';
import { WebFetchResultRenderer } from './web-fetch/result-renderer.js';
import { WebSearchResultRenderer } from './web-search/result-renderer.js';
import { WriteResultRenderer } from './write/result-renderer.js';

// ── Known tool names (for tools without executors yet) ──────────────────
const KNOWN_TOOL_NAMES: string[] = [
  'git', 'powershell',
  'task-describe',
  'cron-create', 'cron-delete', 'cron-list',
  'lsp',
];

// Re-export core APIs for convenience
export { getToolMeta, getToolRiskLevel, executeTool, hasExecutor };
export { getAnthropicTools } from '@coderix/core';

// Build renderer lookup maps
const useRendererByName = new Map<string, ToolUseRenderer>();
const resultRendererByName = new Map<string, ToolResultRenderer>();

// Wire up known renderers
useRendererByName.set('bash', BashRenderer);
useRendererByName.set('read', ReadRenderer);
useRendererByName.set('write', WriteRenderer);
useRendererByName.set('update', UpdateRenderer);
useRendererByName.set('edit', UpdateRenderer); // backward-compatible alias
useRendererByName.set('glob', GlobRenderer);
useRendererByName.set('grep', GrepRenderer);
useRendererByName.set('WebFetch', WebFetchRenderer);
useRendererByName.set('WebSearch', WebSearchRenderer);
useRendererByName.set('TodoWrite', TodoWriteRenderer);
useRendererByName.set('TaskCreate', TaskCreateRenderer);
useRendererByName.set('TaskUpdate', TaskUpdateRenderer);
useRendererByName.set('TaskList', TaskListRenderer);
useRendererByName.set('TaskGet', TaskGetRenderer);
useRendererByName.set('TaskOutput', TaskOutputRenderer);
useRendererByName.set('TaskStop', TaskStopRenderer);
useRendererByName.set('skill', SkillRenderer);
useRendererByName.set('AskUserQuestion', AskUserQuestionRenderer);
useRendererByName.set('EnterPlanMode', EnterPlanModeRenderer);
useRendererByName.set('ExitPlanMode', ExitPlanModeRenderer);
useRendererByName.set('NotebookEdit', NotebookEditRenderer);
useRendererByName.set('Agent', AgentRenderer);
useRendererByName.set('SendMessage', SendMessageRenderer);

resultRendererByName.set('bash', BashResultRenderer);
resultRendererByName.set('glob', GlobResultRenderer);
resultRendererByName.set('grep', GrepResultRenderer);
resultRendererByName.set('read', ReadResultRenderer);
resultRendererByName.set('skill', SkillResultRenderer);
resultRendererByName.set('TaskCreate', TaskCreateResultRenderer);
resultRendererByName.set('TaskGet', TaskGetResultRenderer);
resultRendererByName.set('TaskList', TaskListResultRenderer);
resultRendererByName.set('TaskOutput', TaskOutputResultRenderer);
resultRendererByName.set('TaskStop', TaskStopResultRenderer);
resultRendererByName.set('TaskUpdate', TaskUpdateResultRenderer);
resultRendererByName.set('WebFetch', WebFetchResultRenderer);
resultRendererByName.set('WebSearch', WebSearchResultRenderer);
resultRendererByName.set('write', WriteResultRenderer);
resultRendererByName.set('EnterPlanMode', EnterPlanModeResultRenderer);
resultRendererByName.set('AskUserQuestion', AskUserQuestionResultRenderer);

// Generic fallback for known (executor-less) tool names
for (const name of KNOWN_TOOL_NAMES) {
  useRendererByName.set(name, GenericToolRenderer);
  resultRendererByName.set(name, GenericToolResultRenderer);
}

/** Look up a tool-use renderer by name. Falls back to GenericToolRenderer. */
export function getToolUseRenderer(toolName: string): ToolUseRenderer {
  return useRendererByName.get(toolName) ?? GenericToolRenderer;
}

/** Look up a tool-result renderer by name. Falls back to GenericToolResultRenderer. */
export function getToolResultRenderer(toolName: string): ToolResultRenderer {
  return resultRendererByName.get(toolName) ?? GenericToolResultRenderer;
}
