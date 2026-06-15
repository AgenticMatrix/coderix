import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'web-search',
  description:
    'Search the web. Returns result blocks with titles, URLs, and snippets.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 2,
        description: 'The search query to use',
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include search results from these domains',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Never include search results from these domains',
      },
    },
    required: ['query'],
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};
