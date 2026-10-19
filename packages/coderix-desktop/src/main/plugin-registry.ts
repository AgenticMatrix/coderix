/**
 * Registered plugin loader — the generic "registration" mechanism.
 *
 * Reads `~/.coderix/plugin-registry.json` (see `@coderix/core`
 * `readPluginRegistry`) and, for every registered plugin directory:
 *
 *   1. MCP     — register each server declared in `plugin.json` `mcp` block
 *   2. env     — export the plugin's `.env` + `runtime.env` into `process.env`
 *
 * Skills are NOT symlinked anywhere: each registered plugin is a self-contained
 * local Claude Code plugin (its `skills/` tree ships with it), and
 * `claude-code-engine.ts` loads those plugin directories through the SDK's
 * `plugins` option — so loading a plugin auto-loads its bundled skills.
 *
 * This replaces the cad-specific `installCadControlMcp` / `applyCadEnv` /
 * `installCadSkills` trio. Idempotent: MCP entries are re-written from the
 * plugin's declaration (so a plugin that moves keeps working).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readPluginRegistry } from '../../../../packages/coderix-core/src/plugins/registry.js';
import { readPluginManifest } from '../../../../packages/coderix-core/src/agents/plugin-manifest.js';
import { addMcpConfig } from '../../../../packages/coderix-core/src/mcp/config-loader.js';

/** Parse a minimal `KEY=VALUE` env file (comments and blank lines skipped). */
function loadDotEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  const file = path.join(dir, '.env');
  if (!existsSync(file)) return env;
  try {
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    // unreadable .env — ignore
  }
  return env;
}

/** Resolve `${CODERIX_PLUGIN_ROOT}` and `${ENV:NAME}` placeholders in a value. */
function resolvePlaceholders(
  value: string,
  pluginRoot: string,
  env: Record<string, string | undefined>,
): string {
  return value
    .replace(/\$\{CODERIX_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? '');
}

/**
 * Directories of registered plugins that ship a `skills/` tree. The claude-code
 * engine loads these as local plugins via the SDK `plugins` option, so a plugin's
 * bundled skills become available to any conversation that enables them.
 */
export function listRegisteredPluginDirs(): string[] {
  return readPluginRegistry()
    .map((entry) => entry.path)
    .filter((dir) => existsSync(path.join(dir, 'skills')));
}

/** Load every registered plugin's MCP servers + runtime env into the engine. */
export async function installRegisteredPlugins(): Promise<void> {
  const registry = readPluginRegistry();
  for (const entry of registry) {
    const root = entry.path;
    if (!existsSync(path.join(root, 'plugin.json'))) {
      console.warn(`[Plugins] registry entry has no plugin.json — skipping ${root}`);
      continue;
    }

    const manifest = await readPluginManifest(root);
    if (!manifest) {
      console.warn(`[Plugins] invalid plugin.json — skipping ${root}`);
      continue;
    }

    const pluginName = manifest.name ?? entry.name ?? path.basename(root);
    const dotEnv = loadDotEnv(root);
    const resolveEnv: Record<string, string | undefined> = { ...process.env, ...dotEnv };

    // 1. MCP servers
    for (const [name, decl] of Object.entries(manifest.mcp ?? {})) {
      const command = resolvePlaceholders(decl.command, root, resolveEnv);
      if (!command) {
        console.warn(`[Plugins] ${pluginName}: mcp '${name}' command resolved empty — skipping`);
        continue;
      }
      const args = (decl.args ?? []).map((a) => resolvePlaceholders(a, root, resolveEnv));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(decl.env ?? {})) {
        env[k] = resolvePlaceholders(v, root, resolveEnv);
      }
      addMcpConfig(
        name,
        { type: 'stdio', command, args, ...(Object.keys(env).length > 0 ? { env } : {}) },
        'user',
      );
      console.log(`[Plugins] ${pluginName}: registered mcp '${name}'`);
    }

    // 2. Runtime env
    for (const [k, v] of Object.entries(dotEnv)) process.env[k] = v;
    for (const [k, v] of Object.entries(manifest.runtime?.env ?? {})) {
      process.env[k] = resolvePlaceholders(v, root, resolveEnv);
    }
  }
}
