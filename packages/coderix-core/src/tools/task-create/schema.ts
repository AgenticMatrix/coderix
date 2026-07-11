import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskCreate',
  description:
    'Create a new task in the task list. Each task has a unique ID and tracks its own status and dependencies.\n\nUse this proactively for: (1) complex multi-step tasks with 3+ steps, (2) non-trivial tasks that need careful planning, (3) the user provides multiple tasks, (4) after receiving new instructions — immediately capture them as tasks, (5) when you start working — mark it in_progress BEFORE beginning.\n\nSkip for: single straightforward tasks, trivial tasks, purely conversational/informational requests.\n\nCreate tasks with clear, actionable subjects in imperative form. After creating tasks, use TaskUpdate to set up dependencies.',
  input_schema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'A brief, actionable title for the task (imperative form, e.g. "Fix authentication bug")',
      },
      description: {
        type: 'string',
        description: 'What needs to be done — include enough detail to make the task actionable',
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous form shown in the spinner when the task is in_progress (e.g. "Fixing authentication bug")',
      },
      metadata: {
        type: 'object',
        description: 'Arbitrary metadata to attach to the task',
      },
    },
    required: ['subject', 'description'],
  },
  _meta: { riskLevel: 'safe' },
};
