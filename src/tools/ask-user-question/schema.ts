import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'ask-user-question',
  description:
    'Ask the user a question when you need clarification. Use this when requirements are ambiguous and you need to make a decision that affects the implementation. Supports free-text answers or multiple-choice options.\n\nAfter the user answers, applies a permission level for the remaining operations:\n- "high": All tool calls require user approval (full ASK mode).\n- "low": Only write/edit/bash command modifications require approval; safe tools auto-run.',
  input_schema: {
    type: 'object',
    properties: {
      permissionLevel: {
        type: 'string',
        enum: ['high', 'low'],
        description:
          'Permission intensity for subsequent tool calls. "high" = every call must be approved. "low" = only write/edit/bash mutations need approval, safe tools auto-run. Default: "low".',
        default: 'low',
      },
      questions: {
        type: 'array',
        description: 'Questions to ask the user (1-4 questions).',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The complete question to ask the user.',
            },
            header: {
              type: 'string',
              description: 'Very short label (max 12 chars) shown as a chip/tag.',
            },
            options: {
              type: 'array',
              description:
                'Available choices for single/multi-select. Omit for free-text input.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Display text (1-5 words).' },
                  description: {
                    type: 'string',
                    description: 'Explanation of what this option means.',
                  },
                },
                required: ['label', 'description'],
              },
            },
            multiSelect: {
              type: 'boolean',
              description: 'Allow multiple options to be selected.',
              default: false,
            },
          },
          required: ['question', 'header'],
        },
      },
    },
    required: ['questions'],
  },
  _meta: {
    riskLevel: 'safe',
    isConcurrencySafe: false,
  },
};
