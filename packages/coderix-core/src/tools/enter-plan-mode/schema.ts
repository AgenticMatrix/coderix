import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'EnterPlanMode',
  description:
    'Use this tool proactively when you are about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n' +
    '## When to Use This Tool\n\n' +
    'Prefer using EnterPlanMode for implementation tasks unless they are simple. Use it when ANY of these conditions apply:\n\n' +
    '1. New Feature or Greenfield Project — building something substantial from scratch (e.g. a new app, a new service, a major new capability)\n' +
    '2. Significant Architectural Ambiguity — multiple reasonable approaches exist and the choice meaningfully affects the codebase\n' +
    '3. Unclear Requirements — you need to explore and clarify before you can make progress\n' +
    '4. High-Impact Restructuring — the task will significantly restructure existing code and getting buy-in first reduces risk\n' +
    '5. Cross-Cutting Changes — changes that touch many files across different modules or layers\n\n' +
    '## When NOT to Use This Tool\n\n' +
    'Only skip EnterPlanMode for simple, well-scoped tasks:\n' +
    '- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\n' +
    '- Adding a single function or component with clear requirements\n' +
    '- Bug fixes where the fix is clear once you understand the bug\n' +
    '- Tasks where the user has given very specific, detailed step-by-step instructions\n' +
    '- Pure research/exploration tasks (use the Agent tool with explore agent instead)\n\n' +
    'If unsure whether to use it, err on the side of planning — it is better to get alignment upfront than to redo work.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  _meta: {
    riskLevel: 'safe',
    isConcurrencySafe: true,
  },
};
