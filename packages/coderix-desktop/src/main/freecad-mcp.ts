/**
 * FreeCAD MCP bootstrap — registers the `freecad` stdio MCP server (the upstream
 * freecad-mcp, launched with `uv` against the freecad-mcp checkout) and seeds the
 * freecad-harness plugin manifest, so the "freecad-harness" plugin's conversations
 * can resolve `freecad` tools (the agent drives a running FreeCAD via freecad-mcp,
 * which forwards FreeCAD Python commands over XML-RPC to the addon on port 9875).
 *
 * Mirrors blender-mcp.ts: coderix only registers freecad-mcp as an external stdio
 * server — the plugin manifest carries the modeling workflow prompt (adapted from
 * freecad-harness's `server/config.mjs` SYSTEM_PROMPT). Idempotent against content:
 * an existing `freecad` config is left as-is; the plugin manifest is re-seeded only
 * when its system prompt changed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMcpConfig, getMcpConfig } from '../../../../packages/coderix-core/src/mcp/config-loader.js';
import { resolveFreecadMcpDir, resolveFreecadUv, resolveFreecadHost } from './freecad-paths.js';

const FREECAD_SERVER = 'freecad';

/**
 * Register the external freecad-mcp server in the user-scoped config
 * (`~/.coderix/mcp.json`). The MCP SDK's stdio subprocess only inherits a whitelist
 * of env vars, so the addon host and the absolute `uv` path are written into the
 * command line rather than left to ambient env. `--only-text-feedback` keeps every
 * tool result text-only (no ImageContent), which pure-text models (deepseek) need;
 * `--host` points at the FreeCAD addon (default 127.0.0.1).
 */
export function installFreecadMcp(): void {
  const existing = getMcpConfig(FREECAD_SERVER);
  if (existing) {
    console.log(`[FreecadMcp] ${FREECAD_SERVER} already configured — leaving as-is`);
    return;
  }

  const mcpDir = resolveFreecadMcpDir();
  if (!existsSync(path.join(mcpDir, 'pyproject.toml'))) {
    console.warn(`[FreecadMcp] ${mcpDir} not found — skipping freecad MCP registration`);
    return;
  }

  const uv = resolveFreecadUv();
  const host = resolveFreecadHost();
  addMcpConfig(
    FREECAD_SERVER,
    {
      type: 'stdio',
      command: uv,
      args: ['--directory', mcpDir, 'run', 'freecad-mcp', '--only-text-feedback', '--host', host],
    },
    'user',
  );
  console.log(
    `[FreecadMcp] registered ${FREECAD_SERVER} -> ${uv} --directory ${mcpDir} run freecad-mcp --only-text-feedback --host ${host}`,
  );
}

// ---------------------------------------------------------------------------
// Plugin manifest seed
// ---------------------------------------------------------------------------

/**
 * FreeCAD modeling workflow prompt — the agent identity for the freecad-harness
 * plugin. Adapted from freecad-harness's `server/config.mjs` SYSTEM_PROMPT.
 */
const FREECAD_SYSTEM_PROMPT = [
  '# FreeCAD 建模助手',
  '',
  '你通过 `freecad` MCP 工具操控 FreeCAD（RPC 端口 9875）。可用工具包括：',
  'create_document / create_object / edit_object / delete_object / get_objects /',
  'get_object / list_documents / execute_code / execute_code_async /',
  'insert_part_from_library / get_rpc_status / run_fem_analysis。',
  '',
  '重要约束：',
  '- 你是纯文本模型，无法看到图片/截图：不要调用 get_view（它只返回图片）。',
  '  改用 get_objects / get_object / execute_code 等文本工具做几何校验',
  '  （读取对象属性、尺寸、包围盒、面/边数量等）。',
  '- 建模完成后，用文本工具核对关键尺寸，并明确汇报结果（例如外径、齿数、厚度）。',
  '- 用户正在屏幕上实时观看 FreeCAD，界面右侧会自动显示截图，你无需生成图片。',
  '- 用中文简洁回复，先给结论再给步骤。',
].join('\n');

interface ManifestAgentBlock {
  agentType: string;
  whenToUse: string;
  permissionMode: string;
  tools: string[];
  systemPrompt: string;
}

function buildManifest(systemPrompt: string): Record<string, unknown> {
  return {
    name: 'freecad-harness',
    version: '1.0.0',
    description: '对话式 FreeCAD 建模',
    icon: 'freecad',
    skills: [],
    mcpServers: ['freecad'],
    display: { kind: 'freecad-viewer' },
    agent: {
      agentType: 'freecad-harness',
      whenToUse: '对话式 FreeCAD 建模、几何核对与导出。',
      permissionMode: 'auto',
      tools: ['*'],
      systemPrompt,
    } satisfies ManifestAgentBlock,
  };
}

/**
 * Seed (or re-sync) the global freecad-harness plugin manifest. Idempotent against
 * the *content*: re-seeds when the workflow prompt differs from what's already on
 * disk, otherwise leaves the manifest untouched.
 */
export function installFreecadPluginManifest(): void {
  const pluginDir = path.join(os.homedir(), '.coderix', 'plugins', 'freecad-harness');
  const manifestPath = path.join(pluginDir, 'plugin.json');

  const manifest = buildManifest(FREECAD_SYSTEM_PROMPT);

  let existingPrompt: string | undefined;
  try {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      agent?: { systemPrompt?: string };
    };
    existingPrompt = existing.agent?.systemPrompt;
  } catch {
    // No manifest yet — seed fresh below.
  }

  if (existingPrompt === FREECAD_SYSTEM_PROMPT) return;

  try {
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log(
      `[FreecadMcp] ${existingPrompt === undefined ? 'seeded' : 'updated'} plugin manifest at ${manifestPath}`,
    );
  } catch (err) {
    console.warn('[FreecadMcp] failed to seed plugin manifest:', err instanceof Error ? err.message : err);
  }
}
