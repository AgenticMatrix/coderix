import type { ToolSchema } from '../../tools/types.js';

export const schema: ToolSchema = {
  name: 'Agent',
  description: `Launch a new agent to handle complex, multi-step tasks. Each agent type has
specific capabilities and tools available to it.

Three spawn paths:
- Standard: provide agent_type to launch a pre-defined sub-agent
- Fork: omit agent_type to fork the parent with full context (faster, shares prompt cache)
- Swarm teammate: provide team_name + name to spawn a process-level teammate
  (tmux/iTerm2/in-process backends — requires CODERIX_EXPERIMENTAL_AGENT_TEAMS)

Sub-agents cannot spawn further sub-agents (depth limit = 1).`,

  input_schema: {
    type: 'object',
    properties: {
      agent_type: {
        type: 'string',
        description: 'The type of sub-agent. "explore" is read-only search, "plan" is architecture design, "general-purpose" has full tool access. Omit to fork the parent agent with full context.',
      },
      prompt: {
        type: 'string',
        description: 'The task for the agent to perform. Be specific and include all necessary context.',
      },
      model: {
        type: 'string',
        description: 'Optional model override for this agent.',
      },
      background: {
        type: 'boolean',
        description: 'When true, the agent runs in the background. Use TaskGet to check progress. Defaults to true for swarm teammates.',
      },
      team_name: {
        type: 'string',
        description: 'Team name when spawning as a swarm teammate. Requires name to also be set. Enables SendMessage for inter-team communication.',
      },
      name: {
        type: 'string',
        description: 'Member display name within the team. Used as the sender identity for SendMessage and as the addressable name for inter-team communication.',
      },
      mode: {
        type: 'string',
        description: 'Permission mode override for this agent (default: "auto").',
      },
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description: 'Isolation mode. "worktree" creates a temporary git worktree for this agent, isolating all file operations from the main working directory. The worktree is automatically cleaned up when the agent completes (if no changes were made).',
      },
    },
    required: ['prompt'],
  },
  _meta: { riskLevel: 'mutation', isConcurrencySafe: true },
};
