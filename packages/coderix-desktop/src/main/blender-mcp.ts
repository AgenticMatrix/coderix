/**
 * Blender MCP bootstrap — registers the official `blender` stdio MCP server and
 * seeds the blender-harness plugin manifest, so the "blender-harness" plugin's
 * conversations can resolve `blender` tools (the agent drives a running Blender
 * via the official Blender MCP, which forwards bpy code over TCP to the addon).
 *
 * Unlike cad_harness (which owns a Python `cad-control` MCP server), Blender's
 * control surface is the upstream Blender MCP (`uv run blender-mcp` from the
 * blender-mcp checkout) — coderix only registers it as an external stdio server,
 * exactly like cad-control. Idempotent against content: an existing `blender`
 * config is left as-is; the plugin manifest is re-seeded only when its system
 * prompt changed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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

// ---------------------------------------------------------------------------
// Plugin manifest seed
// ---------------------------------------------------------------------------

/**
 * Blender modeling workflow prompt — the agent identity for the blender-harness
 * plugin. Adapted from blender-harness's `server/config.mjs` SYSTEM_PROMPT and
 * `docs/blender-mcp-skill.md` §3.3.
 */
const BLENDER_SYSTEM_PROMPT = [
  '# Blender 3D 建模助手',
  '',
  '你通过 `blender` MCP 工具操控正在运行的 Blender 实例（官方 Blender MCP，TCP 端口 9876）。',
  '核心工具：',
  '- execute_blender_code：在 Blender 内执行任意 bpy Python 代码（最常用，建模/材质/灯光/相机/导出全靠它）。',
  '- get_objects_summary / get_object_detail_summary：读取场景对象层级与属性，做几何核对。',
  '- render_viewport_to_path / render_thumbnail_to_path：渲染当前场景到文件。',
  '- get_screenshot_of_area_as_image：截取单个编辑器区域（返回 PNG，供视觉核对）。',
  '- jump_to_view3d_object_by_name：把 3D 视口聚焦到指定对象。',
  '- get_python_api_docs / search_api_docs / search_manual_docs：查询 bpy API 与用户手册。',
  '',
  'execute_blender_code 的返回值约定：在代码里把要返回的数据放进 `result` 字典，',
  '例如 `result = {"objects": len(bpy.data.objects)}`；`result` 必须是 dict 且 JSON 可序列化。',
  '',
  '建模工作流约束：',
  '- 用 execute_blender_code 分小步构建模型（每次一个逻辑步骤），避免单段超长代码超时。',
  '- 步骤间用 get_objects_summary / get_object_detail_summary 核对结构、尺寸、包围盒、面数。',
  '- 完成后把 .blend 保存到工作目录（cwd），再用 bpy.ops.export_scene.gltf 导出同名 .glb。',
  '- 右侧面板会自动轮询渲染当前场景的预览图，你无需生成或回传图片。',
  '- 用中文简洁回复：先给结论（建了什么、关键尺寸），再给步骤要点。',
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
    name: 'blender-harness',
    version: '1.0.0',
    description: '对话式 Blender 建模',
    icon: 'blender',
    skills: [],
    mcpServers: ['blender'],
    display: { kind: 'blender-viewer' },
    agent: {
      agentType: 'blender-harness',
      whenToUse: '对话式 Blender 建模、渲染与导出。',
      permissionMode: 'auto',
      tools: ['*'],
      systemPrompt,
    } satisfies ManifestAgentBlock,
  };
}

/**
 * Seed (or re-sync) the global blender-harness plugin manifest. Idempotent
 * against the *content*: re-seeds when the workflow prompt differs from what's
 * already on disk, otherwise leaves the manifest untouched.
 */
export function installBlenderPluginManifest(): void {
  const pluginDir = path.join(os.homedir(), '.coderix', 'plugins', 'blender-harness');
  const manifestPath = path.join(pluginDir, 'plugin.json');

  const manifest = buildManifest(BLENDER_SYSTEM_PROMPT);

  let existingPrompt: string | undefined;
  try {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      agent?: { systemPrompt?: string };
    };
    existingPrompt = existing.agent?.systemPrompt;
  } catch {
    // No manifest yet — seed fresh below.
  }

  if (existingPrompt === BLENDER_SYSTEM_PROMPT) return;

  try {
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    console.log(
      `[BlenderMcp] ${existingPrompt === undefined ? 'seeded' : 'updated'} plugin manifest at ${manifestPath}`,
    );
  } catch (err) {
    console.warn('[BlenderMcp] failed to seed plugin manifest:', err instanceof Error ? err.message : err);
  }
}
