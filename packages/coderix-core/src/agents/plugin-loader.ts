/**
 * Plugin Agent Loader — discovers and loads agent definitions from installed
 * plugins.
 *
 * Plugin directory structure:
 *   .coderix/plugins/            (project)  and  ~/.coderix/plugins/ (global)
 *     plugin-name/
 *       plugin.json        — manifest (see plugin-manifest.ts); may carry a
 *                            top-level `agent` identity (system prompt / model /
 *                            tools) for manifest-only plugins
 *       agents/            — agent definition files (*.md / *.json)
 *
 * Agent names from plugins are namespace-prefixed:
 *   pluginName:agentName
 *
 * A manifest-only plugin (one with `agent` but no agents/ files) synthesizes a
 * single top-level agent with `agentType` = `${name}:${name}` by default.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, basename, extname } from 'path';
import type { CustomAgentDefinition, PluginAgentDefinition } from '../core/types.js';
import { parseAgentFromMarkdown, parseAgentFromJson } from './loader.js';
import { scanPluginDirs, pluginAgentType, type PluginManifest } from './plugin-manifest.js';

export interface PluginLoadResult {
  agents: PluginAgentDefinition[];
  errors: Array<{ plugin: string; error: string }>;
}

/**
 * Load agent definitions from all installed plugins under `.coderix/plugins/`
 * (and, when `includeGlobal` is set, `~/.coderix/plugins/`).
 */
export async function loadPluginAgents(
  cwd: string,
  opts?: { includeGlobal?: boolean },
): Promise<PluginLoadResult> {
  const agents: PluginAgentDefinition[] = [];
  const errors: Array<{ plugin: string; error: string }> = [];

  const entries = await scanPluginDirs(cwd, opts);

  for (const { pluginPath, pluginName, manifest } of entries) {
    // ── 1. Manifest-only agent identity (plugin.json `agent` block) ──────
    if (manifest?.agent) {
      agents.push(synthesizeManifestAgent(pluginPath, pluginName, manifest));
    }

    // ── 2. Agent definition files (agents/ + agentsPaths) ────────────────
    const scanPaths: string[] = [];
    const defaultAgentsDir = join(pluginPath, 'agents');
    try {
      await stat(defaultAgentsDir);
      scanPaths.push(defaultAgentsDir);
    } catch {
      // no agents dir — skip
    }
    if (manifest?.agentsPaths) {
      for (const p of manifest.agentsPaths) {
        const resolved = p.startsWith('/') ? p : join(pluginPath, p);
        try {
          await stat(resolved);
          scanPaths.push(resolved);
        } catch {
          // skip inaccessible path
        }
      }
    }

    for (const scanPath of scanPaths) {
      try {
        const files = await readdir(scanPath);
        for (const file of files) {
          const ext = extname(file).toLowerCase();
          if (!['.md', '.json'].includes(ext)) continue;

          const filePath = join(scanPath, file);
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
              if (parsed) agent = rebrandAgent(parsed, pluginName, pluginPath);
            } else {
              const parsedJson = JSON.parse(content) as unknown;
              const name = basename(file, ext);
              const parsed = parseAgentFromJson(name, parsedJson as Record<string, unknown>, 'userSettings', filePath);
              if (parsed) agent = rebrandAgent(parsed, pluginName, pluginPath);
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

/**
 * Synthesize a PluginAgentDefinition from a manifest-only plugin's `agent` block.
 */
function synthesizeManifestAgent(
  pluginPath: string,
  pluginName: string,
  manifest: PluginManifest,
): PluginAgentDefinition {
  const a = manifest.agent!;
  return {
    agentType: pluginAgentType(manifest),
    whenToUse: a.whenToUse ?? manifest.description ?? '',
    ...(a.tools ? { tools: a.tools } : {}),
    ...(a.disallowedTools ? { disallowedTools: a.disallowedTools } : {}),
    ...(manifest.skills ? { skills: manifest.skills } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.permissionMode ? { permissionMode: a.permissionMode } : {}),
    source: 'plugin' as const,
    plugin: pluginName,
    getSystemPrompt: () => (a.systemPrompt ?? '').replace(/\$\{CODERIX_PLUGIN_ROOT\}/g, pluginPath),
  };
}

/**
 * Rebrand a file-based agent into a plugin agent: namespace the agentType and
 * substitute `${CODERIX_PLUGIN_ROOT}` in its system prompt.
 */
function rebrandAgent(
  parsed: CustomAgentDefinition,
  pluginName: string,
  pluginPath: string,
): PluginAgentDefinition {
  const namespacedType = `${pluginName}:${parsed.agentType}`;
  return {
    agentType: namespacedType,
    whenToUse: parsed.whenToUse,
    ...(parsed.tools ? { tools: parsed.tools } : {}),
    ...(parsed.disallowedTools ? { disallowedTools: parsed.disallowedTools } : {}),
    ...(parsed.skills ? { skills: parsed.skills } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
    ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
    ...(parsed.contextBudget !== undefined ? { contextBudget: parsed.contextBudget } : {}),
    ...(parsed.background ? { background: parsed.background } : {}),
    ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
    ...(parsed.color ? { color: parsed.color } : {}),
    ...(parsed.memory ? { memory: parsed.memory } : {}),
    ...(parsed.initialPrompt ? { initialPrompt: parsed.initialPrompt } : {}),
    source: 'plugin' as const,
    plugin: pluginName,
    getSystemPrompt: () => parsed.getSystemPrompt().replace(/\$\{CODERIX_PLUGIN_ROOT\}/g, pluginPath),
  };
}
