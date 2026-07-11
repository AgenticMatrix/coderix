import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskUpdate',
  description:
    'Update a task in the task list — change its status, subject, description, owner, dependencies, or metadata.\n\n## Status Workflow\n\nTasks progress through three states: `pending` → `in_progress` → `completed`. Use `deleted` to permanently remove a task that is no longer relevant.\n\n## CRITICAL RULES\n\n**Before starting work:** Mark the task `in_progress`. Never start implementing without updating the status first — the task list is your public commitment to what you are doing.\n\n**After finishing work:** Mark the task `completed` immediately. Do not batch — complete tasks one at a time as you finish them, then call TaskList to find your next task.\n\n**Only mark completed when FULLY done.** Keep the task `in_progress` if:\n- Tests are failing or not yet run\n- Implementation is partial or missing pieces\n- You hit unresolved errors or blockers\n- Required files or dependencies are missing\n\n**When blocked:** Keep the current task `in_progress` and create a NEW task describing what needs to be resolved. Use `addBlockedBy` to link them.\n\n**Before starting any task:** Call TaskGet to verify its `blockedBy` list is empty. Do not start work on a blocked task.\n\n## Fields\n\n- **status**: `pending` | `in_progress` | `completed` | `deleted`\n- **subject**: Updated title (imperative form)\n- **description**: Updated description\n- **activeForm**: Present-continuous label shown while in_progress, e.g. "Running tests"\n- **owner**: Assign the task to an agent by name\n- **addBlocks**: Task IDs that CANNOT start until THIS task completes\n- **addBlockedBy**: Task IDs that must complete before THIS task can start\n- **metadata**: Key-value pairs to merge into the task (set a key to `null` to remove it)\n\nRead the task with TaskGet before updating — its state may have changed.\n\n## Examples\n\nStart working on a task:\n```json\n{"taskId": "1", "status": "in_progress"}\n```\n\nFinish a task:\n```json\n{"taskId": "1", "status": "completed"}\n```\n\nRemove an irrelevant task:\n```json\n{"taskId": "1", "status": "deleted"}\n```\n\nMake task 2 depend on task 1 (task 2 cannot start until task 1 finishes):\n```json\n{"taskId": "2", "addBlockedBy": ["1"]}\n```\n\nClaim a task for yourself:\n```json\n{"taskId": "1", "owner": "my-agent-name"}\n```',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to update',
      },
      subject: {
        type: 'string',
        description: 'New subject for the task',
      },
      description: {
        type: 'string',
        description: 'New description for the task',
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous form shown while in_progress, e.g. "Running tests"',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'New status for the task',
      },
      owner: {
        type: 'string',
        description: 'Assign this task to an agent by name',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that cannot start until this task completes',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that must complete before this task can start',
      },
      metadata: {
        type: 'object',
        description: 'Key-value metadata to merge into the task. Set a key to null to remove it.',
      },
    },
    required: ['taskId'],
  },
  _meta: { riskLevel: 'safe' },
};
