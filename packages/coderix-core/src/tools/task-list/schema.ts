import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskList',
  description:
    'List all tasks in the task list. Use this to: see what tasks are available (pending, no owner, not blocked), check overall progress, find blocked tasks that need dependency resolution, and — importantly — after completing a task check for newly unblocked work or claim your next task. Prefer working on tasks in ID order (lowest ID first) when multiple are available, as earlier tasks often set up context for later ones.\n\nReturns each task\'s id, subject, status, owner, and blockedBy list. Use TaskGet for full details on a specific task.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};
