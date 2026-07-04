import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'EnterPlanMode',
  description:
    'Use this tool proactively when you are about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n' +
    'When to use: New Feature Implementation, Multiple Valid Approaches, Code Modifications affecting existing behavior, Architectural Decisions, Multi-File Changes (3+ files), Unclear Requirements needing exploration, or User Preferences Matter.\n\n' +
    'When NOT to use: Single-line or few-line fixes (typos, obvious bugs), Adding a single function with clear requirements, Tasks with very specific detailed instructions, Pure research/exploration tasks.\n\n' +
    'Important: This tool REQUIRES user approval — they must consent to entering plan mode. If unsure whether to use it, err on the side of planning.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  _meta: {
    riskLevel: 'safe',
    isConcurrencySafe: true,
  },
};
