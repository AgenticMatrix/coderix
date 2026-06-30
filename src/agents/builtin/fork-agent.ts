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
    'Fork agent — inherits the parent agent\'s full context including conversation history, system prompt, and tool set. Used when no specific agent_type is specified.',
  tools: '*', // All parent tools pass through (minus globally-disallowed)
  model: 'inherit',
  maxTurns: 20,
  contextBudget: 120_000,
  getSystemPrompt: () => {
    // The fork path passes the parent's already-rendered system prompt bytes
    // directly via agentSpawn.renderedSystemPrompt. Re-assembling here could
    // diverge from the parent bytes and bust the prompt cache.
    return 'You are a forked sub-agent with full context of the parent agent. Complete the assigned task efficiently and return a concise summary.';
  },
};
