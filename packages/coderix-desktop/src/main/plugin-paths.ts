/**
 * Shared plugin path helpers — the agentstation hub is where coderix's
 * self-contained plugins (cad-harness, blender-harness, …) live:
 *
 *   ~/Documents/codeagent/agentstation_hub/plugins/<area>/<plugin>/
 *
 * The registry (`~/.coderix/plugin-registry.json`) is the source of truth for
 * where a plugin actually is; the hub layout is only the default the plugin
 * path modules fall back to when nothing is registered.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root of the agentstation plugin hub checkout. */
export const HUB_PLUGINS_DIR = path.join(
  os.homedir(),
  'Documents',
  'codeagent',
  'agentstation_hub',
  'plugins',
);

/** A default plugin dir under the hub, e.g. `hubPluginDir('cad', 'cad-harness')`. */
export function hubPluginDir(...segments: string[]): string {
  return path.join(HUB_PLUGINS_DIR, ...segments);
}

/**
 * Read one `KEY=VALUE` entry from a plugin's `.env`. Returns '' when the file or
 * the key is absent. Plugin-local config (interpreter paths, ports) lives here
 * rather than in the plugin manifest so a checkout stays self-describing.
 */
export function readPluginEnvValue(root: string, key: string): string {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return '';
  try {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === key) return m[2];
    }
  } catch {
    // unreadable .env — treat as absent
  }
  return '';
}
