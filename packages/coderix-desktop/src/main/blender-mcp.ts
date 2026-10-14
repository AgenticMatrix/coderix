/**
 * Blender MCP bootstrap — registers the official `blender` stdio MCP server so
 * conversations can drive a running Blender (the agent controls Blender via the
 * official Blender MCP, which forwards bpy code over TCP to the addon).
 *
 * Unlike cad_harness (which owns a Python `cad-control` MCP server), Blender's
 * control surface is the upstream Blender MCP (`uv run blender-mcp` from the
 * blender-mcp checkout) — coderix only registers it as an external stdio server,
 * exactly like cad-control. Idempotent: an existing `blender` config is left as-is.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { addMcpConfig, getMcpConfig } from '../../../../packages/coderix-core/src/mcp/config-loader.js';
import {
  resolveBlenderMcpDir,
  resolveBlenderUv,
  resolveBlenderHost,
  resolveBlenderPort,
} from './blender-paths.js';

const BLENDER_SERVER = 'blender';

/**
 * Register the external Blender MCP server in the user-scoped config
 * (`~/.coderix/mcp.json`). The MCP SDK's stdio subprocess only inherits a
 * whitelist of env vars, so the addon endpoint (BLENDER_MCP_HOST/PORT) and the
 * absolute `uv` path are written into the config rather than left to ambient env.
 */
export function installBlenderMcp(): void {
  const existing = getMcpConfig(BLENDER_SERVER);
  if (existing) {
    console.log(`[BlenderMcp] ${BLENDER_SERVER} already configured — leaving as-is`);
    return;
  }

  const mcpDir = resolveBlenderMcpDir();
  if (!existsSync(path.join(mcpDir, 'pyproject.toml'))) {
    console.warn(`[BlenderMcp] ${mcpDir} not found — skipping blender MCP registration`);
    return;
  }

  const uv = resolveBlenderUv();
  addMcpConfig(
    BLENDER_SERVER,
    {
      type: 'stdio',
      command: uv,
      args: ['--directory', mcpDir, 'run', 'blender-mcp'],
      env: {
        BLENDER_MCP_HOST: resolveBlenderHost(),
        BLENDER_MCP_PORT: String(resolveBlenderPort()),
      },
    },
    'user',
  );
  console.log(`[BlenderMcp] registered ${BLENDER_SERVER} -> ${uv} --directory ${mcpDir} run blender-mcp`);
}
