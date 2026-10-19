#!/usr/bin/env node
/**
 * setup-officeharness-plugin — bundle OfficeHarness V3 into a self-contained
 * Coderix plugin directory and register it.
 *
 * Produces:
 *   ~/Documents/apps/OfficeHarness/officeharness_plugins/office-harness/
 *     plugin.json          (Coderix manifest: skills/MCP/agent/display)
 *     prompt.md            (agent system prompt)
 *     .env                 (absolute profile dir)
 *     .claude-plugin/      (Claude Code plugin identity for the SDK)
 *     skills/ppt/SKILL.md  (Coderix-facing skill)
 *     host/ runtime/ ...   (the original OfficeHarness package)
 *
 * and appends/updates the plugin in ~/.coderix/plugin-registry.json.
 *
 * The OfficeHarness profile (mounts, sources, exports) lives outside the plugin
 * directory at ~/.coderix/officeharness/embedded so re-running this script
 * never deletes user file bindings or recovery material.
 *
 * Idempotent: re-running refreshes the bundled package and re-registers without
 * duplicating the registry entry.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const SRC = process.env.OFFICEHARNESS_SRC ?? path.join(HOME, 'Documents', 'apps', 'OfficeHarness', 'officeharness-v3');
const PLUGIN_DIR =
  process.env.OFFICEHARNESS_PLUGIN_DIR ??
  path.join(HOME, 'Documents', 'apps', 'OfficeHarness', 'officeharness_plugins', 'office-harness');
const PROFILE_DIR =
  process.env.OFFICEHARNESS_PROFILE_DIR ?? path.join(HOME, '.coderix', 'officeharness', 'embedded');
const REGISTRY_PATH = path.join(HOME, '.coderix', 'plugin-registry.json');
const TEMPLATE_DIR = path.join(HERE, 'officeharness-plugin');

const EXCLUDES = new Set(['.DS_Store', '.git', '.profile']);

function ensureSource() {
  if (!existsSync(path.join(SRC, '.claude-plugin', 'plugin.json'))) {
    throw new Error(`OfficeHarness source not found: ${SRC}`);
  }
  if (!existsSync(path.join(SRC, 'runtime', 'bin', 'node'))) {
    throw new Error(`OfficeHarness bundled runtime not found: ${SRC}/runtime/bin/node`);
  }
}

function copyPackage() {
  rmSync(PLUGIN_DIR, { recursive: true, force: true });
  mkdirSync(path.dirname(PLUGIN_DIR), { recursive: true });
  cpSync(SRC, PLUGIN_DIR, {
    recursive: true,
    force: true,
    filter: (src) => {
      const relative = path.relative(SRC, src);
      return relative === '' || !relative.split(path.sep).some((part) => EXCLUDES.has(part));
    },
  });

  // Managed-host launch validates the bundled runtime's size and mode, so keep
  // the executable bits after the copy.
  chmodSync(path.join(PLUGIN_DIR, 'runtime', 'bin', 'node'), 0o755);
  const picker = path.join(
    PLUGIN_DIR,
    'host',
    'native',
    'OfficeHarness Directory Picker.app',
    'Contents',
    'MacOS',
    'officeharness-directory-picker',
  );
  if (existsSync(picker)) chmodSync(picker, 0o755);

  // Coderix registers the MCP server from plugin.json and does not use the
  // Claude Desktop `/ppt-open` hooks; leaving them would add dead commands to a
  // coderix session and could re-register the same server through `.mcp.json`.
  rmSync(path.join(PLUGIN_DIR, 'hooks'), { recursive: true, force: true });
  rmSync(path.join(PLUGIN_DIR, '.mcp.json'), { force: true });
}

function sourceVersion() {
  const manifest = JSON.parse(readFileSync(path.join(SRC, '.claude-plugin', 'plugin.json'), 'utf8'));
  if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('OfficeHarness source has no version');
  return manifest.version;
}

function writePluginManifest(version) {
  const manifest = {
    name: 'office-harness',
    version,
    description: '对话式 PPT 编辑（原生 Impress 工作区）',
    icon: 'presentation',
    skills: ['ppt'],
    mcpServers: ['officeharness'],
    display: { kind: 'office-viewer' },
    agent: {
      agentType: 'office-harness',
      whenToUse: '对话式创建、编辑、保存 PPTX；与用户在右侧原生 Impress 面板中接续编辑同一份文稿。',
      permissionMode: 'auto',
      tools: ['*'],
      systemPromptFile: 'prompt.md',
    },
    mcp: {
      officeharness: {
        command: '${CODERIX_PLUGIN_ROOT}/runtime/bin/node',
        args: ['${CODERIX_PLUGIN_ROOT}/host/mcp.cjs'],
        env: {
          OFFICEHARNESS_MANAGED_HOST: '1',
          OFFICEHARNESS_CONNECTION_FILE: '${ENV:OFFICEHARNESS_PROFILE_DIR}/connection.json',
        },
      },
    },
    runtime: {
      env: {
        OFFICEHARNESS_PLUGIN_ROOT: '${CODERIX_PLUGIN_ROOT}',
        OFFICEHARNESS_PROFILE_DIR: '${ENV:OFFICEHARNESS_PROFILE_DIR}',
      },
    },
  };
  writeFileSync(path.join(PLUGIN_DIR, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function writeEnv() {
  // The plugin's minimal dotenv parser accepts KEY=VALUE with the rest of the
  // line as the value; keep this file free of comments for portability.
  writeFileSync(path.join(PLUGIN_DIR, '.env'), `OFFICEHARNESS_PROFILE_DIR=${PROFILE_DIR}\n`);
}

function writeTemplates() {
  const prompt = path.join(TEMPLATE_DIR, 'prompt.md');
  const skill = path.join(TEMPLATE_DIR, 'SKILL.md');
  if (!existsSync(prompt) || !existsSync(skill)) {
    throw new Error(`Coderix templates missing under ${TEMPLATE_DIR}`);
  }
  cpSync(prompt, path.join(PLUGIN_DIR, 'prompt.md'));
  mkdirSync(path.join(PLUGIN_DIR, 'skills', 'ppt'), { recursive: true });
  cpSync(skill, path.join(PLUGIN_DIR, 'skills', 'ppt', 'SKILL.md'));
}

function register() {
  let registry = { plugins: [] };
  if (existsSync(REGISTRY_PATH)) {
    try {
      registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    } catch {
      registry = { plugins: [] };
    }
  }
  if (!Array.isArray(registry.plugins)) registry.plugins = [];
  registry.plugins = registry.plugins.filter((entry) => {
    const name = typeof entry === 'string' ? '' : entry?.name;
    const entryPath = typeof entry === 'string' ? entry : entry?.path;
    return name !== 'office-harness' && entryPath !== PLUGIN_DIR;
  });
  registry.plugins.push({ name: 'office-harness', path: PLUGIN_DIR });
  mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

function assertExecutable(file) {
  const st = statSync(file);
  if (!st.isFile() || (st.mode & 0o111) === 0) throw new Error(`not executable after copy: ${file}`);
}

function main() {
  ensureSource();
  const version = sourceVersion();

  mkdirSync(path.dirname(PLUGIN_DIR), { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });

  copyPackage();
  writePluginManifest(version);
  writeEnv();
  writeTemplates();

  assertExecutable(path.join(PLUGIN_DIR, 'runtime', 'bin', 'node'));
  register();

  console.log(`[office-harness] plugin:  ${PLUGIN_DIR}`);
  console.log(`[office-harness] profile: ${PROFILE_DIR}`);
  console.log(`[office-harness] version: ${version}`);
  console.log('[office-harness] registered in ~/.coderix/plugin-registry.json');
}

main();
