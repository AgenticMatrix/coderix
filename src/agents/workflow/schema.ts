import type { ToolSchema } from '../../tools/types.js';

export const schema: ToolSchema = {
  name: 'workflow',
  description: `Execute a multi-agent workflow script that orchestrates parallel sub-agents.

The script is a JavaScript subset that provides:
- agent(prompt, opts?) — spawn a sub-agent and return its result
- parallel(thunks) — run multiple agents concurrently, return all results
- pipeline(items, ...stages) — run items through sequential stages with pipelining
- phase(title) — mark a progress phase

Workflow agents are capped at 16 concurrent and 1000 total.
Scripts cannot access the filesystem, network, or Node.js APIs.`,
  input_schema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: 'The workflow script (JavaScript subset). Must start with metadata: export const meta = { name, description, phases? }. Then use agent(), parallel(), pipeline(), and phase().',
      },
      args: {
        type: 'object',
        description: 'Optional arguments passed to the script as the global `args` variable.',
      },
    },
    required: ['script'],
  },
  _meta: { riskLevel: 'mutation', isConcurrencySafe: true },
};
