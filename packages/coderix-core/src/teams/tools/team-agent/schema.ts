import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'TeamAgent',
  description: `Spawn a worker agent into a team. Team workers communicate via SendMessage and can run independently of the parent agent.

Team workers are different from regular sub-agents (use the Agent tool for those):
- Team workers persist across the session and use SendMessage for communication
- TeamAgent blocks until the worker completes by default, but supports background mode via background: true or Ctrl+B
- To run multiple workers, spawn them one at a time sequentially

Use TeamAgent when you need persistent workers within a team structure. Use Agent when you need a one-off sub-agent to complete a task and return results directly.

Prerequisites:
- A team must already exist (use TeamCreate first)
- The team_name must match an existing team

The worker will be registered in the team and can be messaged via SendMessage(agent_name: "<name>", team_name: "<team>", text: "...").`,

  input_schema: {
    type: 'object',
    properties: {
      team_name: {
        type: 'string',
        description: 'The name of an existing team to spawn this worker into. Create a team first with TeamCreate.',
      },
      name: {
        type: 'string',
        description: 'Human-readable display name for this worker (e.g. "researcher", "tester", "reviewer"). Used as the sender identity for SendMessage and as the addressable name for inter-team communication.',
      },
      prompt: {
        type: 'string',
        description: 'The full task for this worker to perform. Be specific and include all necessary context. The worker starts with zero conversation context.',
      },
      agent_type: {
        type: 'string',
        description: 'The type of agent definition to use. "explore" is read-only search, "plan" is architecture design, "general-purpose" has full tool access. Defaults to "general-purpose".',
      },
      model: {
        type: 'string',
        description: 'Optional model override for this worker.',
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) human-readable label for this worker, shown in the UI. Example: "Research auth bug".',
      },
      background: {
        type: 'boolean',
        description: 'When true, the worker runs in the background. Use SendMessage to communicate with it. Results will be delivered automatically when complete.',
      },
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description: 'Isolation mode. "worktree" creates a temporary git worktree for this worker, isolating all file operations from the main working directory.',
      },
    },
    required: ['team_name', 'name', 'prompt'],
  },
  _meta: { riskLevel: 'mutation', isConcurrencySafe: true },
};
