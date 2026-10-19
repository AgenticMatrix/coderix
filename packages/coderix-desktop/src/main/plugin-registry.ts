/**
 * Registered plugin loader — the generic "registration" mechanism.
 *
 * Reads `~/.coderix/plugin-registry.json` (see
 * `@coderix/core` `readPluginRegistry`) and, for every registered plugin
 * directory, loads its self-contained content into the running engine:
 *
 *   1. skills  — symlink each `skills/<name>/` into `~/.coderix/skills/`
 *   2. MCP     — register each server declared in `plugin.json` `mcp` block
 *   3. env     — export the plugin's `.env` + `runtime.env` into `process.env`
 *
 * This replaces the cad-specific `installCadSkills` / `installCadControlMcp` /
 * `applyCadEnv` trio: a plugin now ships everything it needs, and being listed
 * in the registry is all that's required for it to load. Idempotent: an existing
 * skill symlink is never touched; MCP entries are re-written from the plugin's
 * declaration (so a plugin that moves keeps working).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPluginRegistry } from '../../../../packages/coderix-core/src/plugins/registry.js';
import { readPluginManifest } from '../../../../packages/coderix-core/src/agents/plugin-manifest.js';
import { addMcpConfig } from '../../../../packages/coderix-core/src/mcp/config-loader.js';

const CODERIX_SKILLS_DIR = path.join(os.homedir(), '.coderix', 'skills');

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

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

/** Symlink every `skills/<name>/` (with a SKILL.md) into `~/.coderix/skills/`. */
function installPluginSkills(pluginRoot: string): number {
  const skillsRoot = path.join(pluginRoot, 'skills');
  let names: string[];
  try {
    names = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return 0;
  }

  try {
    mkdirSync(CODERIX_SKILLS_DIR, { recursive: true });
  } catch {
    // best-effort
  }

  let linked = 0;
  for (const name of names) {
    const src = path.join(skillsRoot, name);
    if (!existsSync(path.join(src, 'SKILL.md'))) continue;
    const dest = path.join(CODERIX_SKILLS_DIR, name);
    if (pathExists(dest)) {
      // A stale symlink (pointing elsewhere, e.g. a former cad_harness checkout)
      // is replaced so the plugin's own skills take effect. A real directory is
      // a user-created skill and is never touched.
      try {
        if (!lstatSync(dest).isSymbolicLink()) continue;
        if (readlinkSync(dest) === src) continue;
        unlinkSync(dest);
      } catch {
        continue;
      }
    }
    try {
      symlinkSync(src, dest, 'dir');
      linked++;
    } catch (err) {
      console.warn(`[Plugins] failed to link skill ${name}:`, err);
    }
  }
  return linked;
}

/** Load every registered plugin's skills / MCP / env into the engine. */
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

    // 1. Skills
    const linked = installPluginSkills(root);
    if (linked > 0) console.log(`[Plugins] ${pluginName}: linked ${linked} skills`);

    // 2. MCP servers
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

    // 3. Runtime env
    for (const [k, v] of Object.entries(dotEnv)) process.env[k] = v;
    for (const [k, v] of Object.entries(manifest.runtime?.env ?? {})) {
      process.env[k] = resolvePlaceholders(v, root, resolveEnv);
    }
  }
}
