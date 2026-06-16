/**
 * Skill tool schema — invokes a skill by name, loading its SKILL.md body
 * into the conversation context.
 */

import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'skill',
  description:
    'Execute a skill within the main conversation. Skills provide specialized capabilities and domain knowledge. Available skills are listed in system-reminder messages in the conversation. Invoke with the exact skill name.',
  input_schema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The name of the skill to invoke (from the available skills list).',
      },
      args: {
        type: 'string',
        description: 'Optional arguments to pass to the skill.',
      },
    },
    required: ['skill'],
  },
  _meta: {
    riskLevel: 'safe',
    isConcurrencySafe: true,
  },
};
