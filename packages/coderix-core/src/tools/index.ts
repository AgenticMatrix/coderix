/**
 * Tools — Public API (core-only, no UI renderers).
 *
 * To add a new tool:
 *   1. Create tools/<name>/ with schema.ts, executor.ts, index.ts
 *   2. Import and register in registry.ts
 */

export {
  getAnthropicTools,
  getToolMeta,
  getToolRiskLevel,
  executeTool,
  hasExecutor,
} from './registry.js';

export type {
  ToolPlugin,
  ToolMeta,
  ToolSchema,
  ToolExecutor,
  ToolResult,
  ExecutorOptions,
} from './types.js';
