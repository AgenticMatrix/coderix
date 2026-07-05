import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'EnterPlanMode',
  description:
    'Use this tool when a task has genuine ambiguity about the right approach and getting user input before coding would prevent significant rework. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n' +
    'When to use: Significant Architectural Ambiguity (multiple reasonable approaches with meaningful trade-offs), Unclear Requirements (you need to explore and clarify before making progress), or High-Impact Restructuring (the task will significantly restructure existing code and getting buy-in first reduces risk).\n\n' +
    'When NOT to use: The task is straightforward even if it touches multiple files, the user\'s request is specific enough that the implementation path is clear, adding a feature with an obvious implementation pattern, bug fixes where the fix is clear once you understand the bug, research/exploration tasks (use the Agent tool instead), the user says things like "can we work on X" or "let\'s do X" — just get started. When in doubt, prefer starting work and using AskUserQuestion for specific questions over entering a full planning phase.\n\n' +
    'Important: This tool REQUIRES user approval — they must consent to entering plan mode.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  _meta: {
    riskLevel: 'safe',
    isConcurrencySafe: true,
  },
};
