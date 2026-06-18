/**
 * Agent registry builder — assembles an AgentRegistry pre-loaded with
 * built-in agent definitions, then discovers user/project custom agents
 * from disk.
 *
 * Registration order determines override priority (last write wins):
 *   Layer 1: built-in (lowest priority)
 *   Layer 2: plugin agents (future)
 *   Layer 3: user-level agents   (~/.coder/agents/*.md)
 *   Layer 4: project-level agents (<cwd>/.coder/agents/*.md)
 *
 * Adapted from claude-code-best's loadAgentsDir + getBuiltInAgents.
 */

import { homedir } from 'os';
import { join } from 'path';
import { AgentRegistry } from '../core/agent-registry.js';
import type { AgentDefinitionsResult } from '../core/types.js';
import { exploreAgent, planAgent, generalPurposeAgent, verificationAgent, claudeCodeGuideAgent, statuslineSetupAgent } from './builtin/index.js';
import { getCoordinatorAgents } from './builtin/coordinator-agents.js';
import { loadAgentsFromDir, getActiveAgents } from './loader.js';
import { loadPluginAgents } from './plugin-loader.js';
import { isCoordinatorModeEnabled } from '../teams/coordinator-mode.js';

/**
 * Build an AgentRegistry by layering agents from all discovery sources.
 * Must be awaited — scans disk for user and project agent files.
 */
export async function buildAgentRegistry(cwd: string): Promise<{
  registry: AgentRegistry;
  result: AgentDefinitionsResult;
}> {
  const registry = new AgentRegistry();

  // Layer 1: built-in agents
  const coordinatorEnabled = isCoordinatorModeEnabled();
  if (coordinatorEnabled) {
    // Coordinator mode: register specialized worker agents
    for (const agent of getCoordinatorAgents()) {
      registry.register(agent);
    }
  }
  // Always register the base set (coordinator can still use them)
  registry.register(exploreAgent);
  registry.register(planAgent);
  registry.register(generalPurposeAgent);
  registry.register(verificationAgent);
  registry.register(claudeCodeGuideAgent);
  registry.register(statuslineSetupAgent);

  // Layer 2: plugin agents
  const pluginResult = await loadPluginAgents(cwd);
  for (const agent of pluginResult.agents) {
    registry.register(agent);
  }
  const pluginFailedFiles = pluginResult.errors.map(e => ({
    path: e.plugin,
    error: e.error,
  }));

  // Layer 3: user-level agents
  const userDir = join(homedir(), '.coder', 'agents');
  const userResult = await loadAgentsFromDir(userDir, 'userSettings');
  for (const agent of userResult.agents) {
    registry.register(agent);
  }

  // Layer 4: project-level agents
  const projectDir = join(cwd, '.coder', 'agents');
  const projectResult = await loadAgentsFromDir(projectDir, 'projectSettings');
  for (const agent of projectResult.agents) {
    registry.register(agent);
  }

  // Build the result shape
  const allAgents = registry.list();
  const activeAgents = getActiveAgents(allAgents);
  const allFailedFiles = [
    ...pluginFailedFiles,
    ...(userResult.failedFiles ?? []),
    ...(projectResult.failedFiles ?? []),
  ];

  const result: AgentDefinitionsResult = {
    activeAgents,
    allAgents,
    ...(allFailedFiles.length > 0 ? { failedFiles: allFailedFiles } : {}),
  };

  return { registry, result };
}
