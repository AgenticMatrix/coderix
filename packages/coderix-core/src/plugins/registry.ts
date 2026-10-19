/**
 * Plugin registry — the file that "registers" self-contained plugin directories
 * for auto-loading at boot.
 *
 * A registered plugin is an *external* directory (not necessarily under
 * `~/.coderix/plugins/`) that ships its own `plugin.json` plus its skills, MCP
 * servers, prompt, and viewer runtime. Registering it here makes coderix's
 * discovery layer (`scanPluginDirs`) and the desktop's generic loader
 * (`installRegisteredPlugins`) treat it exactly like an installed plugin.
 *
 * Registry file: `~/.coderix/plugin-registry.json`
 *
 *   { "plugins": [ { "name": "cad-harness", "path": "/abs/path/to/cad-harness" } ] }
 *
 * Entries may also be bare strings (the plugin name is then derived from
 * `plugin.json` `name` or the directory basename).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const PLUGIN_REGISTRY_PATH = join(homedir(), '.coderix', 'plugin-registry.json');

export interface RegisteredPlugin {
  /** Explicit name from the registry entry, or '' when derived elsewhere. */
  name: string;
  /** Absolute path to the plugin directory. */
  path: string;
}

/**
 * Read the registry. Returns `[]` when the file is absent or malformed — the
 * caller then falls back to whatever discovery already covers.
 */
export function readPluginRegistry(): RegisteredPlugin[] {
  if (!existsSync(PLUGIN_REGISTRY_PATH)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PLUGIN_REGISTRY_PATH, 'utf-8')) as unknown;
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const list = (raw as Record<string, unknown>).plugins;
  if (!Array.isArray(list)) return [];

  const out: RegisteredPlugin[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry.trim()) out.push({ name: '', path: entry.trim() });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      const path = typeof rec.path === 'string' ? rec.path.trim() : '';
      if (!path) continue;
      out.push({ name: typeof rec.name === 'string' ? rec.name : '', path });
    }
  }
  return out;
}
