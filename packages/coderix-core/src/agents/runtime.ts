/**
 * Agent runtime wiring — assembles the pieces the QueryEngine needs to spawn
 * sub-agents (Agent / TeamAgent tools): the SubAgentRegistry, the
 * SystemPromptAssembler, and the AgentRegistry of agent-type definitions.
 *
 * CLI, ACP and the desktop app all call `createAgentRuntime()` so the agent
 * tooling behaves identically everywhere, instead of each frontend wiring its
 * own inline copy (which is how the desktop ended up without sub-agents).
 */

import { SubAgentRegistry } from '../core/subagent-registry.js';
import { SystemPromptAssembler } from '../core/system-prompt.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import { buildAgentRegistry } from './registry.js';
import { setSubAgentRegistry } from './agent-spawn/registry-ref.js';

export interface AgentRuntime {
  subAgentRegistry: SubAgentRegistry;
  systemPromptAssembler: SystemPromptAssembler;
  agentRegistry: AgentRegistry;
}

/**
 * One SubAgentRegistry per process. The EventBus emitter and the module-level
 * registry ref (`getSubAgentRegistry()`, used by TaskGet/TaskOutput/TaskStop/
 * Listen) both assume a single shared instance — so concurrent per-session
 * engines must reuse it rather than each creating their own.
 */
let sharedSubAgentRegistry: SubAgentRegistry | null = null;

/** AgentRegistry scan results, cached per cwd (desktop builds one engine per session). */
const agentRegistryByCwd = new Map<string, AgentRegistry>();

/**
 * Create (or reuse) the agent runtime for a working directory. Idempotent:
 * the SubAgentRegistry is a process singleton and the AgentRegistry is cached
 * by cwd, so calling this once per session engine is cheap.
 */
export async function createAgentRuntime(cwd: string): Promise<AgentRuntime> {
  if (!sharedSubAgentRegistry) {
    sharedSubAgentRegistry = new SubAgentRegistry();
    setSubAgentRegistry(sharedSubAgentRegistry);
  }

  let agentRegistry = agentRegistryByCwd.get(cwd);
  if (!agentRegistry) {
    agentRegistry = (await buildAgentRegistry(cwd)).registry;
    agentRegistryByCwd.set(cwd, agentRegistry);
  }

  return {
    subAgentRegistry: sharedSubAgentRegistry,
    systemPromptAssembler: new SystemPromptAssembler(),
    agentRegistry,
  };
}
