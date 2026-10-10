/**
 * CAD MCP bootstrap — registers the `cad-control` stdio MCP server and seeds the
 * cad-harness plugin manifest, so the "cad-harness" plugin's conversations can
 * resolve `cad-control` tools (the agent controls the CAD component via MCP).
 *
 * The server subprocess command is the bundled `coderix` binary (production) or a
 * `coderix` on PATH (dev after `installCli`). When neither exists the plugin still
 * works — its `cad`/`cad-viewer` skills are the fallback — but the MCP tools won't
 * resolve. Idempotent: an existing `cad-control` config and an existing plugin
 * manifest are never overwritten.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addMcpConfig, getMcpConfig } from '../../../../packages/coderix-core/src/mcp/config-loader.js';
import { resolveCadHarnessRoot, resolveCadPython } from './cad-paths.js';
import { resolveSourceBin } from './cli-installer.js';

const CAD_CONTROL_SERVER = 'cad-control';

/** The bundled `coderix` binary, or a `coderix` on PATH, or null. */
function resolveCoderixCommand(): string | null {
  const bundled = resolveSourceBin();
  if (bundled) return bundled;
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'coderix');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Register the `cad-control` stdio MCP server in the user-scoped config
 * (`~/.coderix/mcp.json`) with the resolved CAD paths as env — the MCP SDK's
 * stdio subprocess only inherits a whitelist of env vars, so CAD_HARNESS_PATH /
 * CAD_PYTHON must be written into the config rather than left to ambient env.
 */
export function installCadControlMcp(): void {
  const existing = getMcpConfig(CAD_CONTROL_SERVER);
  if (existing) {
    console.log(`[CadMcp] ${CAD_CONTROL_SERVER} already configured — leaving as-is`);
    return;
  }

  const command = resolveCoderixCommand();
  if (!command) {
    console.warn(
      '[CadMcp] coderix binary not found (dev mode) — skipping cad-control MCP registration; cad/cad-viewer skills remain the fallback',
    );
    return;
  }

  const env: Record<string, string> = { CAD_HARNESS_PATH: resolveCadHarnessRoot() };
  const python = resolveCadPython();
  if (python) env.CAD_PYTHON = python;

  addMcpConfig(
    CAD_CONTROL_SERVER,
    { type: 'stdio', command, args: ['--cad-control-mcp'], env },
    'user',
  );
  console.log(`[CadMcp] registered ${CAD_CONTROL_SERVER} -> ${command} --cad-control-mcp`);
}

// ---------------------------------------------------------------------------
// Plugin manifest seed
// ---------------------------------------------------------------------------

const PLUGIN_MANIFEST = {
  name: 'cad-harness',
  version: '1.0.0',
  description: '对话式 CAD 生成',
  icon: 'boxes',
  skills: ['cad', 'cad-viewer'],
  mcpServers: ['cad-control'],
  display: { kind: 'cad-viewer' },
  agent: {
    agentType: 'cad-harness',
    whenToUse: '对话式 STEP-first 参数化 CAD 建模、检查与可视化。',
    permissionMode: 'auto',
    tools: ['*'],
    systemPrompt: [
      'You are the CAD assistant, a STEP-first parametric CAD modeling specialist.',
      '',
      'Workflow:',
      '- Author build123d Python generators named `<name>.step.py` (with a gen_step() entry) for parts designed from scratch; import existing .step/.stp files directly when no generator is needed.',
      '- Treat STEP as the primary artifact. Produce STL/3MF/GLB as secondary exports.',
      '- You have two control surfaces: the `cad` and `cad-viewer` skills (bash-driven scripts under CAD_SKILL_DIR), and the `mcp__cad-control__*` MCP tools (render/export/inspect/snapshot/artifact_build/list_artifacts/focus). Prefer the MCP tools for a single target; each takes a workspace `dir` and cwd-relative target.',
      '- After creating or modifying a model, run an inspect (refs/validate) and a snapshot, then hand the viewer URL to the user via `focus`.',
      '- Keep the STEP output and its Python generator in the same directory with the same basename.',
      '',
      'Run commands from the conversation workspace; target paths are cwd-relative.',
    ].join('\n'),
  },
};

/** Seed the global cad-harness plugin manifest (idempotent). */
export function installCadPluginManifest(): void {
  const pluginDir = path.join(os.homedir(), '.coderix', 'plugins', 'cad-harness');
  const manifestPath = path.join(pluginDir, 'plugin.json');
  if (existsSync(manifestPath)) return;
  try {
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(PLUGIN_MANIFEST, null, 2) + '\n', 'utf-8');
    console.log(`[CadMcp] seeded plugin manifest at ${manifestPath}`);
  } catch (err) {
    console.warn('[CadMcp] failed to seed plugin manifest:', err instanceof Error ? err.message : err);
  }
}
