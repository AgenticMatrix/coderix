/**
 * Plugin Agent Loader — discovers and loads agent definitions from installed
 * plugins.
 *
 * Plugin directory structure:
 *   .coder/plugins/
 *     plugin-name/
 *       plugin.json        — manifest with { name, version, agentsPaths? }
 *       agents/             — agent definition files (*.md / *.json)
 *
 * Agent names from plugins are namespace-prefixed:
 *   pluginName:agentName
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename, extname } from 'path';
import type { PluginAgentDefinition } from '../core/types.js';
import { parseAgentFromMarkdown, parseAgentFromJson } from './loader.js';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** Additional paths to scan for agent definitions. */
  agentsPaths?: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PluginLoadResult {
  agents: PluginAgentDefinition[];
  errors: Array<{ plugin: string; error: string }>;
}

/**
 * Load agent definitions from all installed plugins under `.coder/plugins/`.
 */
export async function loadPluginAgents(
  cwd: string,
): Promise<PluginLoadResult> {
  const pluginsDir = join(cwd, '.coder', 'plugins');
  const agents: PluginAgentDefinition[] = [];
  const errors: Array<{ plugin: string; error: string }> = [];

  let pluginDirs: string[];
  try {
    pluginDirs = await readdir(pluginsDir);
  } catch {
    // No plugins directory — that's fine
    return { agents, errors };
  }

  for (const dirName of pluginDirs) {
    const pluginPath = join(pluginsDir, dirName);
    try {
      const st = await stat(pluginPath);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }

    // Try to read the manifest
    const manifestPath = join(pluginPath, 'plugin.json');
    let manifest: PluginManifest | null = null;
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
        manifest = {
          name: parsed.name,
          version: parsed.version,
          description: parsed.description,
          agentsPaths: Array.isArray(parsed.agentsPaths)
            ? parsed.agentsPaths.filter((p: unknown) => typeof p === 'string')
            : undefined,
        };
      }
    } catch {
      // No manifest — use directory name as plugin name
    }

    const pluginName = manifest?.name ?? dirName;

    // Collect agent paths to scan
    const scanPaths: string[] = [];

    // Default agents directory
    const defaultAgentsDir = join(pluginPath, 'agents');
    try {
      await stat(defaultAgentsDir);
      scanPaths.push(defaultAgentsDir);
    } catch {
      // No agents dir — skip
    }

    // Additional paths from manifest
    if (manifest?.agentsPaths) {
      for (const p of manifest.agentsPaths) {
        const resolved = p.startsWith('/') ? p : join(pluginPath, p);
        try {
          await stat(resolved);
          scanPaths.push(resolved);
        } catch {
          // Skip inaccessible paths
        }
      }
    }

    if (scanPaths.length === 0) continue;

    // Scan all agent paths
    for (const scanPath of scanPaths) {
      try {
        const entries = await readdir(scanPath);
        for (const entry of entries) {
          const ext = extname(entry).toLowerCase();
          if (!['.md', '.json'].includes(ext)) continue;

          const filePath = join(scanPath, entry);
          let content: string;
          try {
            content = await readFile(filePath, 'utf-8');
          } catch {
            errors.push({ plugin: pluginName, error: `Failed to read ${filePath}` });
            continue;
          }

          try {
            let agent: PluginAgentDefinition | null = null;

            if (ext === '.md') {
              const parsed = parseAgentFromMarkdown(filePath, content, 'userSettings');
              if (parsed) {
                // Rebrand as plugin agent with namespace prefix
                const namespacedType = `${pluginName}:${parsed.agentType}`;
                agent = {
                  agentType: namespacedType,
                  whenToUse: parsed.whenToUse,
                  tools: parsed.tools,
                  disallowedTools: parsed.disallowedTools,
                  skills: parsed.skills,
                  model: parsed.model,
                  permissionMode: parsed.permissionMode,
                  maxTurns: parsed.maxTurns,
                  contextBudget: parsed.contextBudget,
                  background: parsed.background,
                  isolation: parsed.isolation,
                  color: parsed.color,
                  memory: parsed.memory,
                  initialPrompt: parsed.initialPrompt,
                  source: 'plugin' as const,
                  plugin: pluginName,
                  getSystemPrompt: () => {
                    const base = parsed.getSystemPrompt();
                    return base.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginPath);
                  },
                };
              }
            } else {
              // JSON
              const parsedJson = JSON.parse(content);
              const name = basename(entry, ext);
              const parsed = parseAgentFromJson(name, parsedJson, 'userSettings', filePath);
              if (parsed) {
                const namespacedType = `${pluginName}:${parsed.agentType}`;
                agent = {
                  agentType: namespacedType,
                  whenToUse: parsed.whenToUse,
                  tools: parsed.tools,
                  disallowedTools: parsed.disallowedTools,
                  skills: parsed.skills,
                  model: parsed.model,
                  permissionMode: parsed.permissionMode,
                  maxTurns: parsed.maxTurns,
                  contextBudget: parsed.contextBudget,
                  background: parsed.background,
                  isolation: parsed.isolation,
                  color: parsed.color,
                  memory: parsed.memory,
                  initialPrompt: parsed.initialPrompt,
                  source: 'plugin' as const,
                  plugin: pluginName,
                  getSystemPrompt: () => {
                    const base = parsed.getSystemPrompt();
                    return base.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginPath);
                  },
                };
              }
            }

            if (agent) {
              agents.push(agent);
            } else {
              errors.push({ plugin: pluginName, error: `Failed to parse agent from ${filePath}` });
            }
          } catch {
            errors.push({ plugin: pluginName, error: `Invalid JSON in ${filePath}` });
          }
        }
      } catch {
        errors.push({ plugin: pluginName, error: `Failed to scan ${scanPath}` });
      }
    }
  }

  return { agents, errors };
}
