/**
 * Agent registry builder — assembles an AgentRegistry pre-loaded with
 * built-in agent definitions.
 *
 * Registration order determines override priority (last write wins):
 *   Layer 1: built-in (lowest priority)
 *   Layer 2: plugin agents (future)
 *   Layer 3: user-level agents (future)
 *   Layer 4: project-level agents (future)
 *   Layer 5: flag-defined agents (future)
 *   Layer 6: managed agents (future)
 */

import { AgentRegistry } from '../core/agent-registry.js';
import { exploreAgent, planAgent, generalPurposeAgent } from './builtin/index.js';

export function buildAgentRegistry(): AgentRegistry {
  const registry = new AgentRegistry();

  // Layer 1: built-in agents
  registry.register(exploreAgent);
  registry.register(planAgent);
  registry.register(generalPurposeAgent);

  return registry;
}
