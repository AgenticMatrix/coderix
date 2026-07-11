import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskUpdate',
  description:
    'Update a task\'s status, subject, description, dependencies, or owner.\n\nStatus workflow: pending → in_progress → completed. Use "deleted" to remove irrelevant tasks.\n\nCRITICAL RULES:\n- Mark a task in_progress BEFORE starting work on it.\n- Mark a task completed IMMEDIATELY after finishing — do not batch completions.\n- After completing a task, call TaskList to find your next task or check if your work unblocked others.\n- ONLY mark completed when FULLY done. Keep in_progress if: tests fail, implementation is partial, you hit unresolved errors, or cannot find necessary files.\n- When blocked, create a new task describing what needs resolution.\n- Read the task with TaskGet before updating — verify blockedBy is empty before starting.\n\nExamples:\n- Start work: {"taskId": "1", "status": "in_progress"}\n- Finish work: {"taskId": "1", "status": "completed"}\n- Set dependency: {"taskId": "2", "addBlockedBy": ["1"]}',
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
        description: 'Present continuous form shown in spinner when in_progress',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'deleted'],
        description: 'New status for the task',
      },
      owner: {
        type: 'string',
        description: 'New owner for the task',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that this task blocks (cannot start until this task completes)',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task IDs that block this task (must complete before this one can start)',
      },
      metadata: {
        type: 'object',
        description: 'Metadata keys to merge into the task',
      },
    },
    required: ['taskId'],
  },
  _meta: { riskLevel: 'safe' },
};
