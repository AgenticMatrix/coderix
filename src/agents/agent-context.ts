/**
 * Agent context isolation via AsyncLocalStorage.
 *
 * When multiple sub-agents run concurrently (e.g. background agents), a shared
 * global mutable state would cause Agent A's events to incorrectly reference
 * Agent B's context. AsyncLocalStorage isolates each async execution chain so
 * concurrent agents don't interfere with each other.
 *
 * Two agent types are supported:
 *   1. SubagentContext  — for Agent tool spawned sub-agents
 *   2. TeammateAgentContext — for swarm/team teammates (future)
 */

import { AsyncLocalStorage } from 'async_hooks';

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** Context for sub-agents spawned via the Agent tool. */
export interface SubagentContext {
  /** The sub-agent's unique ID (from SubAgentRegistry). */
  agentId: string;
  /** The parent session's ID, if applicable. */
  parentSessionId?: string;
  /** Discriminator. */
  agentType: 'subagent';
  /** The sub-agent type name (e.g. "explore", "verification"). */
  subagentName?: string;
  /** Whether this is a built-in agent (vs user-defined custom agent). */
  isBuiltIn?: boolean;
}

/** Context for swarm/team teammates. */
export interface TeammateAgentContext {
  /** Full agent ID, e.g. "researcher@my-team". */
  agentId: string;
  /** Display name, e.g. "researcher". */
  agentName: string;
  /** Team name this teammate belongs to. */
  teamName: string;
  /** UI color assigned to this teammate. */
  agentColor?: string;
  /** The team lead's session ID. */
  parentSessionId: string;
  /** Whether this agent is the team lead. */
  isTeamLead: boolean;
  /** Discriminator. */
  agentType: 'teammate';
}

/** Discriminated union for all agent contexts. */
export type AgentContext = SubagentContext | TeammateAgentContext;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const agentContextStorage = new AsyncLocalStorage<AgentContext>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current agent context, if running within one.
 * Returns undefined on the main thread or outside any agent execution.
 */
export function getAgentContext(): AgentContext | undefined {
  return agentContextStorage.getStore();
}

/**
 * Run an async function within the given agent context.
 * All async operations inside `fn` will see this context via getAgentContext().
 */
export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContextStorage.run(context, fn);
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns true if the context is a SubagentContext. */
export function isSubagentContext(
  context: AgentContext | undefined,
): context is SubagentContext {
  return context?.agentType === 'subagent';
}

/** Returns true if the context is a TeammateAgentContext. */
export function isTeammateAgentContext(
  context: AgentContext | undefined,
): context is TeammateAgentContext {
  return context?.agentType === 'teammate';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a stable log-safe name for the current agent.
 * Returns the agent type name for built-in agents, "user-defined" for custom
 * agents, or undefined if not running within an agent context.
 */
export function getAgentLogName(): string | undefined {
  const context = getAgentContext();
  if (!isSubagentContext(context) || !context.subagentName) {
    return undefined;
  }
  return context.isBuiltIn ? context.subagentName : 'user-defined';
}

/**
 * Create a SubagentContext for an agent-spawn operation.
 */
export function createSubagentContext(
  agentId: string,
  subagentName: string,
  isBuiltIn: boolean,
  parentSessionId?: string,
): SubagentContext {
  return {
    agentId,
    parentSessionId,
    agentType: 'subagent',
    subagentName,
    isBuiltIn,
  };
}
