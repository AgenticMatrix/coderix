/**
 * Blender paths — resolve the Blender MCP source locations reused by the "apps"
 * integration: the official Blender MCP server dir (registered as an external
 * stdio MCP server) and the addon's TCP endpoint (driven directly for live
 * render previews).
 *
 * The `blender-harness` plugin is self-contained and lives in the agentstation
 * hub (`~/Documents/codeagent/agentstation_hub/plugins/blender`). Resolution
 * order: registry → `BLENDER_PLUGIN_ROOT` env → hub checkout. Everything stays
 * overridable via env (`BLENDER_MCP_DIR` / `BLENDER_UV` / `BLENDER_MCP_HOST` /
 * `BLENDER_MCP_PORT`) so the integration isn't pinned to one machine.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPluginRegistry } from '../../../../packages/coderix-core/src/plugins/registry.js';
import { hubPluginDir, readPluginEnvValue } from './plugin-paths.js';

/** The blender-harness plugin root: registry first, then env override, then hub. */
export function resolveBlenderPluginRoot(): string {
  for (const entry of readPluginRegistry()) {
    const isBlender =
      entry.name === 'blender-harness' ||
      (path.basename(entry.path) === 'blender' && existsSync(path.join(entry.path, 'mcp', 'blender')));
    if (isBlender) return entry.path;
  }

  const override = process.env.BLENDER_PLUGIN_ROOT?.trim();
  if (override) return override;
  return hubPluginDir('blender');
}

/**
 * The official Blender MCP server dir (`mcp/blender`, containing `pyproject.toml`
 * with the `blender-mcp = blmcp:main` entry point) — shipped with the plugin.
 * Prefers an explicit `BLENDER_MCP_DIR` env var.
 */
export function resolveBlenderMcpDir(): string {
  const override = process.env.BLENDER_MCP_DIR?.trim();
  if (override) return override;
  return path.join(resolveBlenderPluginRoot(), 'mcp', 'blender');
}

/**
 * `uv` interpreter used to launch the MCP server. Must be an absolute path: the
 * MCP SDK's stdio subprocess only inherits a whitelist of env vars (PATH may be
 * absent), so a bare `uv` would not resolve. Mirrors `resolveCadPython()`:
 * env → plugin `.env` → `~/.local/bin/uv` → PATH lookup.
 */
export function resolveBlenderUv(): string {
  const override = process.env.BLENDER_UV?.trim();
  if (override) return override;
  const fromPlugin = readPluginEnvValue(resolveBlenderPluginRoot(), 'BLENDER_UV');
  if (fromPlugin) return fromPlugin;
  const local = path.join(os.homedir(), '.local', 'bin', 'uv');
  if (existsSync(local)) return local;
  return 'uv';
}

/** The Blender MCP addon's TCP host (the addon listens on it inside Blender). */
export function resolveBlenderHost(): string {
  return (process.env.BLENDER_MCP_HOST || '127.0.0.1').trim();
}

/** The Blender MCP addon's TCP port (default 9876). */
export function resolveBlenderPort(): number {
  return Number(process.env.BLENDER_MCP_PORT || 9876);
}

/**
 * The Blender GUI binary to auto-launch (with the MCP addon enabled). Prefers an
 * explicit `BLENDER_BIN`, then the macOS app binary, then common brew paths.
 */
export function resolveBlenderBin(): string {
  const override = process.env.BLENDER_BIN?.trim();
  if (override) return override;
  const candidates = [
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/opt/homebrew/bin/blender',
    '/usr/local/bin/blender',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'blender';
}

/** Fixed preview render path — Blender is single-instance/single-scene, so all
 *  conversations share one preview image (mirrors blender-harness's shared workspace). */
export function resolveBlenderPreviewPath(): string {
  const override = process.env.BLENDER_PREVIEW_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), '.coderix', 'blender', 'preview.png');
}
