/**
 * Blender paths — resolve the Blender MCP source locations reused by the "apps"
 * integration: the official Blender MCP server dir (registered as an external
 * stdio MCP server) and the addon's TCP endpoint (driven directly for live
 * render previews).
 *
 * Everything defaults to this machine's known checkouts, overridable via env
 * (`BLENDER_MCP_DIR` / `BLENDER_UV` / `BLENDER_MCP_HOST` / `BLENDER_MCP_PORT`)
 * so the integration isn't pinned to one machine.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The official Blender MCP server dir (`<repo>/mcp`, containing `pyproject.toml`
 * with the `blender-mcp = blmcp:main` entry point). Prefers an explicit
 * `BLENDER_MCP_DIR` env var, then the sibling `blender-mcp` checkout under
 * `~/Documents/apps/`.
 */
export function resolveBlenderMcpDir(): string {
  const override = process.env.BLENDER_MCP_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), 'Documents', 'apps', 'blender-mcp', 'mcp');
}

/**
 * `uv` interpreter used to launch the MCP server. Must be an absolute path: the
 * MCP SDK's stdio subprocess only inherits a whitelist of env vars (PATH may be
 * absent), so a bare `uv` would not resolve. Mirrors `resolveCadPython()`.
 */
export function resolveBlenderUv(): string {
  const override = process.env.BLENDER_UV?.trim();
  if (override) return override;
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
  return path.join(os.homedir(), '.coderix', 'blender', 'preview.png');
}
