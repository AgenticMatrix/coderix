#!/usr/bin/env node
/**
 * setup-cad-plugins — bundle cad_harness's necessary components into a
 * self-contained plugin directory and register it, so coderix auto-loads it via
 * the plugin registry (no hardcoded cad_harness paths).
 *
 * Produces:
 *   ~/Documents/apps/cad_project/cad_plugins/cad-harness/
 *     plugin.json   prompt.md   .env   skills/*   mcp/cad-control/*
 * and appends the plugin to ~/.coderix/plugin-registry.json.
 *
 * Idempotent: re-running refreshes the bundled files and re-registers without
 * duplicating the registry entry.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CAD_HARNESS = process.env.CAD_HARNESS_SRC ?? path.join(HOME, 'Documents', 'apps', 'cad_project', 'cad_harness');
const PLUGIN_DIR = path.join(HOME, 'Documents', 'apps', 'cad_project', 'cad_plugins', 'cad-harness');
const REGISTRY_PATH = path.join(HOME, '.coderix', 'plugin-registry.json');

const EXCLUDES = new Set(['.DS_Store', '__pycache__', 'node_modules', '.git']);

function copyTree(src, dest) {
  if (!existsSync(src)) {
    console.warn(`[setup] missing source: ${src}`);
    return;
  }
  const st = statSync(src);
  if (st.isFile()) {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    return;
  }
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDES.has(entry.name)) continue;
    copyTree(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

/** Enumerate vendored skills: non-dot subdirs containing a SKILL.md. */
function skillNames(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

// ── 1. Skills ───────────────────────────────────────────────────────────
const srcSkills = path.join(CAD_HARNESS, 'claude_dir', 'skills');
const skills = skillNames(srcSkills);
for (const name of skills) {
  copyTree(path.join(srcSkills, name), path.join(PLUGIN_DIR, 'skills', name));
}
console.log(`[setup] copied ${skills.length} skills: ${skills.join(', ')}`);

// ── 2. Prompt ───────────────────────────────────────────────────────────
copyTree(path.join(CAD_HARNESS, 'claude_dir', 'CLAUDE_cad.md'), path.join(PLUGIN_DIR, 'prompt.md'));
console.log('[setup] copied prompt.md');

// ── 3. Env ──────────────────────────────────────────────────────────────
copyTree(path.join(CAD_HARNESS, '.env'), path.join(PLUGIN_DIR, '.env'));
console.log('[setup] copied .env');

// ── 4. MCP server ───────────────────────────────────────────────────────
copyTree(path.join(CAD_HARNESS, 'services', 'cad-control', 'server.py'), path.join(PLUGIN_DIR, 'mcp', 'cad-control', 'server.py'));
copyTree(path.join(CAD_HARNESS, 'services', 'cad-control', 'requirements.txt'), path.join(PLUGIN_DIR, 'mcp', 'cad-control', 'requirements.txt'));
console.log('[setup] copied mcp/cad-control');

// ── 5. Manifest ─────────────────────────────────────────────────────────
const manifest = {
  name: 'cad-harness',
  version: '1.0.0',
  description: '对话式 CAD 生成',
  icon: 'boxes',
  skills,
  mcpServers: ['cad-control'],
  display: { kind: 'cad-viewer' },
  agent: {
    agentType: 'cad-harness',
    whenToUse: '对话式 STEP-first 参数化 CAD 建模、检查与可视化。',
    permissionMode: 'auto',
    tools: ['*'],
    systemPromptFile: 'prompt.md',
  },
  mcp: {
    'cad-control': {
      command: '${ENV:CAD_PYTHON}',
      args: ['${CODERIX_PLUGIN_ROOT}/mcp/cad-control/server.py'],
      env: {
        CAD_PYTHON: '${ENV:CAD_PYTHON}',
        CAD_SKILL_DIR: '${CODERIX_PLUGIN_ROOT}/skills/cad',
      },
    },
  },
  runtime: {
    env: {
      CAD_SKILL_DIR: '${CODERIX_PLUGIN_ROOT}/skills/cad',
      CAD_VIEWER_DIR: '${CODERIX_PLUGIN_ROOT}/skills/cad-viewer',
    },
  },
};
writeFileSync(path.join(PLUGIN_DIR, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('[setup] wrote plugin.json');

// ── 6. Register (idempotent append) ─────────────────────────────────────
let registry = { plugins: [] };
if (existsSync(REGISTRY_PATH)) {
  try {
    registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    registry = { plugins: [] };
  }
}
if (!Array.isArray(registry.plugins)) registry.plugins = [];
const already = registry.plugins.some((e) => {
  const p = typeof e === 'string' ? e : e && typeof e === 'object' ? e.path : undefined;
  const n = e && typeof e === 'object' ? e.name : undefined;
  return p === PLUGIN_DIR || n === 'cad-harness';
});
if (!already) {
  registry.plugins.push({ name: 'cad-harness', path: PLUGIN_DIR });
  mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  console.log(`[setup] registered cad-harness -> ${PLUGIN_DIR}`);
} else {
  console.log('[setup] cad-harness already registered');
}

// ── 7. Clear the stale auto-seeded manifest (now superseded by the registry) ──
const staleManifest = path.join(HOME, '.coderix', 'plugins', 'cad-harness');
if (existsSync(staleManifest)) {
  rmSync(staleManifest, { recursive: true, force: true });
  console.log('[setup] removed stale seeded manifest ~/.coderix/plugins/cad-harness');
}
