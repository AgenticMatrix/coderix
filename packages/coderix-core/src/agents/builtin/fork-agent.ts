import type { BuiltInAgentDefinition } from '../../core/types.js';

/**
 * Synthetic agent definition for the fork path.
 *
 * Not registered in the agent registry — used only when `agent_type` is omitted
 * from the Agent input, triggering the fork path. The fork inherits the
 * parent's full tool pool (minus globally-disallowed tools) and the parent's
 * already-rendered system prompt bytes to share the prompt cache.
 */

export const FORK_AGENT_TYPE = 'fork';

export const forkAgent: BuiltInAgentDefinition = {
  agentType: FORK_AGENT_TYPE,
  source: 'built-in',
  baseDir: 'built-in',
  whenToUse:
    'Fork agent — creates a NEW sub-agent that inherits the parent\'s full context (conversation history, system prompt, tools). '
    + 'Use fork when you need a fresh sub-agent to handle a new task with full awareness of what the parent has done. '
    + 'Do NOT use fork to continue an existing sub-agent — for that, call Agent with agent_id + resume: true instead.',
  tools: '*', // All parent tools pass through (minus globally-disallowed)
  model: 'inherit',
  maxTurns: 200,
  contextBudget: 120_000,
  permissionMode: 'bubble',
  getSystemPrompt: () => {
    // The fork path passes the parent's already-rendered system prompt bytes
    // directly via agentSpawn.renderedSystemPrompt. Re-assembling here could
    // diverge from the parent bytes and bust the prompt cache.
    return 'You are a forked sub-agent with full context of the parent agent. Complete the assigned task efficiently and return a concise summary.';
  },
};
