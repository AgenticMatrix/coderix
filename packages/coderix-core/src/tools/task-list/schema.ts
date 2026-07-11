import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskList',
  description:
    'List all tasks in the task list with their current status and dependencies.\n\n## When to Use\n\n- To see what tasks are available to work on (status: `pending`, no owner, not blocked).\n- To check overall progress across all tasks.\n- To find tasks that are blocked and need dependency resolution.\n- **After completing a task** — check for newly unblocked work or claim your next task.\n- **After creating or updating tasks** — confirm the task list reflects your current plan.\n\n## Output\n\nReturns each task with:\n- **id**: Task identifier (use with TaskGet and TaskUpdate).\n- **subject**: Brief description of the task.\n- **status**: `pending`, `in_progress`, or `completed`.\n- **owner**: Agent ID if assigned, empty if unclaimed.\n- **blockedBy**: Task IDs that must be resolved before this task can start.\n\nPrefer working on tasks in **ID order** (lowest first) when multiple are available — earlier tasks often set up context for later ones. Use TaskGet for full details including description, blocks, and metadata.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};
