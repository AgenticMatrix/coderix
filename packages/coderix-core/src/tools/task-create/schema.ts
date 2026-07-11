import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskCreate',
  description:
    'Create a new task in the task list. Each task has a unique ID and tracks its own status, dependencies, and ownership.\n\n## When to Use\n\nUse this tool proactively in these situations:\n\n- **Complex multi-step work** — any task requiring 3 or more distinct steps or actions.\n- **Non-trivial tasks** — work that needs careful planning or spans multiple files and concerns.\n- **After receiving instructions** — capture user requirements as tasks immediately so nothing is forgotten.\n- **User provides a list** — numbered, comma-separated, or bulleted tasks from the user.\n- **When starting work** — create the task, then immediately mark it in_progress via TaskUpdate.\n- **When discovering new work** — if implementation reveals additional steps, capture them as new tasks.\n\n## When NOT to Use\n\nSkip this tool when:\n- There is only one straightforward, single-step task.\n- The work is trivial and tracking provides no benefit.\n- The request is purely conversational or informational (no code changes needed).\n\nIf there is only one trivial task, just do it directly.\n\n## Fields\n\n- **subject** (required): Brief, actionable title in imperative form. Describe the outcome, not the action. Good: "Fix login redirect loop". Bad: "Look at the login code".\n- **description** (required): What needs to be done. Include enough context that someone else could pick it up.\n- **activeForm** (optional): Present-continuous phrase shown while the task is in_progress, e.g. "Fixing login redirect loop". Defaults to the subject if omitted.\n- **metadata** (optional): Arbitrary key-value pairs to attach to the task.\n\nAll tasks start with status `pending`.\n\n## Tips\n\n- Check TaskList first to avoid creating duplicate tasks.\n- Use TaskUpdate after creation to set up dependencies (addBlockedBy / addBlocks).\n- Create tasks before starting work — plan then execute.',
  input_schema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'A brief, actionable title for the task in imperative form, e.g. "Fix authentication bug in login flow"',
      },
      description: {
        type: 'string',
        description: 'What needs to be done — include enough detail to make the task actionable',
      },
      activeForm: {
        type: 'string',
        description: 'Present continuous form shown while in_progress, e.g. "Fixing authentication bug". Defaults to subject if omitted.',
      },
      metadata: {
        type: 'object',
        description: 'Arbitrary key-value metadata to attach to the task',
      },
    },
    required: ['subject', 'description'],
  },
  _meta: { riskLevel: 'safe' },
};
