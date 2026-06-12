/**
 * AgentRegistry — Central registry for agent type definitions.
 *
 * Holds AgentDefinition objects that describe what each agent type is
 * (allowed tools, system prompt, max turns, etc.). This is distinct from
 * SubAgentRegistry, which tracks RUNNING sub-agent instances.
 *
 * Registration order determines priority: later registrations with the
 * same agentType override earlier ones (built-in < plugin < user <
 * project < flag < managed).
 */

import type { AgentDefinition, AgentDefinitionsResult } from './types.js';

export class AgentRegistry {
  private definitions = new Map<string, AgentDefinition>();

  /** Register an agent definition. Same agentType overwrites prior. */
  register(definition: AgentDefinition): void {
    this.definitions.set(definition.agentType, definition);
  }

  /** Look up an agent definition by type name. */
  get(agentType: string): AgentDefinition | undefined {
    return this.definitions.get(agentType);
  }

  /** Return all registered agent definitions. */
  list(): AgentDefinition[] {
    return Array.from(this.definitions.values());
  }

  /** Return definitions in the standard result shape. */
  getDefinitionsResult(): AgentDefinitionsResult {
    const all = this.list();
    return { activeAgents: all, allAgents: all };
  }
}
