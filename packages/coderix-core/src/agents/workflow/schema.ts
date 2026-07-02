import type { ToolSchema } from '../../tools/types.js';

export const schema: ToolSchema = {
  name: 'workflow',
  description: `Execute a multi-agent workflow script that orchestrates parallel sub-agents.

The script is a JavaScript subset that provides:
- agent(prompt, opts?) — spawn a sub-agent. opts: { schema?, model?, effort?, isolation?, agentType?, label? }
- parallel(thunks) — run multiple agents concurrently (barrier: waits for all)
- pipeline(items, ...stages) — run items through sequential stages with true pipelining
- phase(title) — mark a progress phase
- log(message) — emit a log line
- args — the optional args object passed to the workflow
- budget — token budget info: { total, spent(), remaining() }

Workflow agents are capped at 16 concurrent and 1000 total calls.
Scripts run in a sandboxed environment — no filesystem, network, Date.now(), or Math.random().
Scripts must start with: export const meta = { name: "...", description: "..." }
Supports checkpoint/resume: same script + same args → cached agent results are reused.`,
  input_schema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          'The workflow script (JavaScript subset). Must start with: export const meta = { name, description, phases? }. ' +
          'Then use agent(), parallel(), pipeline(), phase(), log(). ' +
          'agent() options: { schema (JSONSchema for structured output), model, effort ("low"|"medium"|"high"|"xhigh"|"max"), isolation ("worktree"), agentType, label }. ' +
          'pipeline() runs items through stages with true pipelining — Item B can start Stage 1 while Item A is in Stage 2.',
      },
      args: {
        description:
          'Optional arguments passed to the script as the global `args` variable. ' +
          'Use this to parameterize named workflows — e.g. pass a file path, ' +
          'research question, or config object. Accessible as `args` in the script.',
      },
      resumeFromRunId: {
        type: 'string',
        description:
          'Optional: resume a previous workflow run. ' +
          'Same script + same args will reuse cached agent results. ' +
          'The first changed agent call and all subsequent calls are re-executed.',
      },
    },
    required: ['script'],
  },
  _meta: { riskLevel: 'mutation', isConcurrencySafe: true },
};
