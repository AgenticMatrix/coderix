/**
 * Plugin manifest — the file-based definition of a "sub-agent plugin".
 *
 * A plugin is a directory (global `~/.coderix/plugins/<name>/` or per-project
 * `<cwd>/.coderix/plugins/<name>/`) containing a `plugin.json` manifest and
 * optionally an `agents/` dir. The manifest declares the plugin's surface area:
 * the agent identity (system prompt / model / tools), the skills and MCP servers
 * it enables on a conversation, and the display component (renderer kind).
 *
 * This module owns:
 *   - the `PluginManifest` schema
 *   - `scanPluginDirs()` — shared discovery of global + project plugin dirs
 *   - `loadPluginManifests()` — the flattened records the desktop renderer uses
 *     to build plugin cards (replacing the hardcoded `APPS` fallback).
 *
 * `loadPluginAgents()` in `plugin-loader.ts` reuses `scanPluginDirs()` and adds
 * the agent-definition synthesis (agents/*.md + manifest.agent).
 */

import { readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** Renderer icon key (mapped to a LucideIcon in the desktop renderer). */
  icon?: string;
  /** Skills enabled on a conversation created from this plugin. */
  skills?: string[];
  /** MCP server names enabled on a conversation created from this plugin. */
  mcpServers?: string[];
  /** Render component discriminator (e.g. `{ kind: 'cad-viewer' }`). */
  display?: { kind: string };
  /** Top-level agent identity for manifest-only plugins (no agents/* files). */
  agent?: {
    /** Defaults to `${name}:${name}` when omitted. */
    agentType?: string;
    whenToUse?: string;
    /** System prompt; `${CODERIX_PLUGIN_ROOT}` is replaced with the plugin dir. */
    systemPrompt?: string;
    model?: string;
    permissionMode?: string;
    tools?: string[];
    disallowedTools?: string[];
  };
  /** Legacy: additional paths (relative to the plugin dir) to scan for agents. */
  agentsPaths?: string[];
}

export interface PluginManifestRecord {
  /** Plugin name (manifest.name ?? directory name). */
  id: string;
  name: string;
  description: string;
  icon: string | null;
  skills: string[];
  mcpServers: string[];
  display: { kind: string } | null;
  /** Agent registry key synthesized for this plugin, or null when it has no agent identity. */
  agentType: string | null;
  /** Absolute plugin directory (for `${CODERIX_PLUGIN_ROOT}` substitution). */
  root: string;
}

export interface PluginScanEntry {
  pluginPath: string;
  pluginName: string;
  manifest: PluginManifest | null;
  source: 'global' | 'project';
}

/**
 * Read + parse a plugin.json manifest. Returns null when absent or invalid.
 */
export async function readPluginManifest(pluginPath: string): Promise<PluginManifest | null> {
  const manifestPath = join(pluginPath, 'plugin.json');
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as Record<string, unknown>;
      const name = typeof p.name === 'string' ? p.name : null;
      if (!name) return null;
      return {
        name,
        ...(typeof p.version === 'string' ? { version: p.version } : {}),
        ...(typeof p.description === 'string' ? { description: p.description } : {}),
        ...(typeof p.icon === 'string' ? { icon: p.icon } : {}),
        ...(Array.isArray(p.skills) ? { skills: p.skills.filter((s): s is string => typeof s === 'string') } : {}),
        ...(Array.isArray(p.mcpServers)
          ? { mcpServers: p.mcpServers.filter((s): s is string => typeof s === 'string') }
          : {}),
        ...(p.display && typeof p.display === 'object' && typeof (p.display as Record<string, unknown>).kind === 'string'
          ? { display: { kind: (p.display as Record<string, unknown>).kind as string } }
          : {}),
        ...(p.agent && typeof p.agent === 'object' ? { agent: normalizeAgentManifest(p.agent as Record<string, unknown>) } : {}),
        ...(Array.isArray(p.agentsPaths)
          ? { agentsPaths: p.agentsPaths.filter((s): s is string => typeof s === 'string') }
          : {}),
      };
    }
  } catch {
    // invalid JSON — treat as manifest-less plugin (name = dir name)
  }
  return null;
}

function normalizeAgentManifest(a: Record<string, unknown>): NonNullable<PluginManifest['agent']> {
  const out: NonNullable<PluginManifest['agent']> = {};
  if (typeof a.agentType === 'string') out.agentType = a.agentType;
  if (typeof a.whenToUse === 'string') out.whenToUse = a.whenToUse;
  if (typeof a.systemPrompt === 'string') out.systemPrompt = a.systemPrompt;
  if (typeof a.model === 'string') out.model = a.model;
  if (typeof a.permissionMode === 'string') out.permissionMode = a.permissionMode;
  if (Array.isArray(a.tools)) out.tools = a.tools.filter((t): t is string => typeof t === 'string');
  if (Array.isArray(a.disallowedTools))
    out.disallowedTools = a.disallowedTools.filter((t): t is string => typeof t === 'string');
  return out;
}

/**
 * Discover plugin directories from the global and (optionally) project roots.
 * Global entries are returned first, project entries last, so callers that keep
 * the last entry per pluginName get project-wins precedence.
 */
export async function scanPluginDirs(
  cwd: string,
  opts?: { includeGlobal?: boolean },
): Promise<PluginScanEntry[]> {
  const entries: PluginScanEntry[] = [];
  const roots: Array<{ dir: string; source: 'global' | 'project' }> = [];

  if (opts?.includeGlobal !== false) {
    roots.push({ dir: join(homedir(), '.coderix', 'plugins'), source: 'global' });
  }
  roots.push({ dir: join(cwd, '.coderix', 'plugins'), source: 'project' });

  for (const { dir, source } of roots) {
    let dirs: string[];
    try {
      dirs = await readdir(dir);
    } catch {
      continue; // no plugins dir — fine
    }
    for (const dirName of dirs) {
      const pluginPath = join(dir, dirName);
      try {
        const st = await stat(pluginPath);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      const manifest = await readPluginManifest(pluginPath);
      entries.push({
        pluginPath,
        pluginName: manifest?.name ?? dirName,
        manifest,
        source,
      });
    }
  }

  return entries;
}

/** The agent registry key for a plugin manifest (or null when no agent identity). */
export function pluginAgentType(manifest: PluginManifest): string {
  return manifest.agent?.agentType ?? `${manifest.name}:${manifest.name}`;
}

/**
 * Flattened plugin records for the renderer's plugin cards.
 * Project entries override global entries with the same name.
 */
export async function loadPluginManifests(
  cwd: string,
  opts?: { includeGlobal?: boolean },
): Promise<PluginManifestRecord[]> {
  const entries = await scanPluginDirs(cwd, opts);
  const byName = new Map<string, PluginScanEntry>();
  for (const entry of entries) {
    byName.set(entry.pluginName, entry); // later (project) wins
  }

  const records: PluginManifestRecord[] = [];
  for (const entry of byName.values()) {
    const m = entry.manifest;
    records.push({
      id: entry.pluginName,
      name: m?.name ?? entry.pluginName,
      description: m?.description ?? '',
      icon: m?.icon ?? null,
      skills: m?.skills ?? [],
      mcpServers: m?.mcpServers ?? [],
      display: m?.display ?? null,
      agentType: m?.agent ? pluginAgentType(m) : null,
      root: entry.pluginPath,
    });
  }
  return records;
}
