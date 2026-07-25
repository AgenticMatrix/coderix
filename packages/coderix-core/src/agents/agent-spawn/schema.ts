import type { ToolSchema } from '../../tools/types.js';

export const schema: ToolSchema = {
  name: 'Agent',
  description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool spawns specialized sub-agents that work in parallel. Each agent type has specific capabilities:
- explore: Fast, read-only codebase search. Use for finding files by pattern (e.g. "src/components/**/*.tsx"), searching for symbols, or answering "where is X defined?".
- plan: Architecture design before implementation. Use for designing the strategy and identifying critical files for a task.
- general-purpose: Full tool access for complex multi-step research and implementation.
- fork_main: Forks the parent agent with full conversation context and unfiltered tools. Use when the agent needs to know what's been discussed and decided — ideal for open-ended research and implementation work that spans multiple files. This is equivalent to omitting agent_type entirely.

Prefer to fork (omit agent_type) when the work benefits from full conversation context — forking inherits your history and shares the prompt cache, so it's faster and smarter about the task. Fork by default for open-ended research and for implementation work that spans more than a couple of files.

When NOT to use the Agent tool:
- Reading a specific file path — use Read directly, it's faster
- Searching for a specific class or function definition — use Glob or Grep directly
- Searching code within 1-3 known files — use Read directly
- Simple, single-step tasks you can handle without delegation overhead
- Spawning a team worker — use TeamAgent instead (requires team_name + name)

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do.
- Launch multiple independent agents in parallel by sending a single message with multiple Agent tool calls — this maximizes throughput.
- When the agent finishes, it returns one message back to you. The result is not visible to the user — relay a concise summary to the user.
- You can run agents in the background using the background parameter. Results will be delivered automatically when complete — do not poll.
- Use foreground (the default) when you need the agent's results before you can proceed. Use background when you have genuinely independent work to do in parallel.
- To continue a previously spawned agent, use agent_id + resume: true. This restores the agent's full transcript and is preferred over spawning a new one for follow-up work.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.).
- If the agent description mentions it should be used proactively, try to use it without the user asking first.
- If the user specifies "in parallel", you MUST send a single message with multiple Agent tool use content blocks.
- isolation: "worktree" runs the agent in a temporary git worktree, isolating all file operations.

Writing the prompt:
The agent starts with zero context — it hasn't seen your conversation or the user's request. Brief it like a smart colleague who just walked in:
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context for the agent to make judgment calls instead of blindly following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Include exact file paths, line numbers, and what specifically to change.

Never delegate understanding. Don't write "based on your findings, fix the bug" or "based on the research, implement it." Write prompts that prove you understood the situation.

Spawn paths:
- Standard: provide agent_type to launch a pre-defined sub-agent (explore, plan, general-purpose).
- Fork: use agent_type="fork_main" (or omit agent_type) to fork the parent with full context and tools.
- Resume: provide agent_id + resume: true to continue a stopped or completed agent.

Sub-agents cannot spawn further sub-agents.`,

  input_schema: {
    type: 'object',
    properties: {
      agent_type: {
        type: 'string',
        description: 'The type of sub-agent. "explore" is read-only search, "plan" is architecture design, "general-purpose" has full tool access, "fork_main" forks the parent with full context and tools. Omit to also trigger fork mode.',
      },
      prompt: {
        type: 'string',
        description: 'The full task for the agent to perform. Be specific and include all necessary context.',
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) human-readable label for this agent, shown in the UI panel. Example: "Investigate auth bug". If omitted, Coderix will derive one from the prompt.',
      },
      model: {
        type: 'string',
        description: 'Optional model override for this agent.',
      },
      background: {
        type: 'boolean',
        description: 'When true, the agent runs in the background. Use TaskGet to check progress.',
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
      agent_id: {
        type: 'string',
        description: 'ID of a previously stopped or completed agent to resume. Requires resume: true. The agent continues with its full conversation transcript and original toolset. Use TaskGet to find available agent IDs. This is the preferred way to send a follow-up task to an existing sub-agent.',
      },
      resume: {
        type: 'boolean',
        description: 'When true, resume the agent identified by agent_id instead of creating a new one. Use this to continue an existing sub-agent\'s work with a new task. Do NOT use fork mode for this — fork creates a new agent from the parent context, not from the sub-agent\'s own context.',
      },
    },
    required: ['prompt'],
  },
  _meta: { riskLevel: 'mutation', isConcurrencySafe: true },
};
