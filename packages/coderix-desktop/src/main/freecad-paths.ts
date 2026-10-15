/**
 * FreeCAD paths — resolve the FreeCAD MCP source locations reused by the "apps"
 * integration: the freecad-mcp checkout (registered as an external stdio MCP
 * server) and the addon's XML-RPC endpoint (driven directly for live screenshots).
 *
 * Everything defaults to this machine's known checkouts, overridable via env
 * (`FREECAD_MCP_DIR` / `FREECAD_UV` / `FREECAD_RPC_HOST` / `FREECAD_RPC_PORT` /
 * `FREECAD_BIN`) so the integration isn't pinned to one machine.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The freecad-mcp server dir (containing `pyproject.toml` with the
 * `freecad-mcp = freecad_mcp.server:main` entry point). Prefers an explicit
 * `FREECAD_MCP_DIR` env var, then the sibling `freecad-mcp` checkout under
 * `~/Documents/apps/cad_project/`.
 */
export function resolveFreecadMcpDir(): string {
  const override = process.env.FREECAD_MCP_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), 'Documents', 'apps', 'cad_project', 'freecad-mcp');
}

/**
 * `uv` interpreter used to launch the MCP server. Must be an absolute path: the
 * MCP SDK's stdio subprocess only inherits a whitelist of env vars (PATH may be
 * absent), so a bare `uv` would not resolve. Mirrors `resolveBlenderUv()`.
 */
export function resolveFreecadUv(): string {
  const override = process.env.FREECAD_UV?.trim();
  if (override) return override;
  const local = path.join(os.homedir(), '.local', 'bin', 'uv');
  if (existsSync(local)) return local;
  return 'uv';
}

/** The FreeCAD addon's XML-RPC host (the addon listens on it inside FreeCAD). */
export function resolveFreecadHost(): string {
  return (process.env.FREECAD_RPC_HOST || '127.0.0.1').trim();
}

/** The FreeCAD addon's XML-RPC port (freecad-mcp hardcodes 9875). */
export function resolveFreecadPort(): number {
  return Number(process.env.FREECAD_RPC_PORT || 9875);
}

/**
 * The FreeCAD addon's XML-RPC endpoint. Python's SimpleXMLRPCServer accepts both
 * `/` and `/RPC2`; freecad-harness uses `/RPC2`.
 */
export function resolveFreecadRpcUrl(): string {
  return `http://${resolveFreecadHost()}:${resolveFreecadPort()}/RPC2`;
}

/**
 * The FreeCAD GUI binary to auto-launch (with the MCP addon's auto-start RPC
 * server). Prefers an explicit `FREECAD_BIN`, then this machine's source-build
 * debug binary, then the standard macOS app binary.
 */
export function resolveFreecadBin(): string {
  const override = process.env.FREECAD_BIN?.trim();
  if (override) return override;
  const candidates = [
    path.join(os.homedir(), 'Downloads', 'FreeCAD', 'build', 'debug', 'bin', 'FreeCAD'),
    '/Applications/FreeCAD.app/Contents/MacOS/FreeCAD',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'FreeCAD';
}

/**
 * The FreeCAD source root to launch from. A CMake source build expects its cwd to
 * be the repo root (where the pixi task runs `build/debug/bin/FreeCAD`), so derive
 * it from the binary path (`…/FreeCAD/build/debug/bin/FreeCAD` → `…/FreeCAD`).
 */
export function resolveFreecadRoot(): string {
  return path.resolve(path.dirname(resolveFreecadBin()), '..', '..', '..');
}
