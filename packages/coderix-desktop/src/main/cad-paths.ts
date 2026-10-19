/**
 * CAD paths — resolve the cad-harness source locations reused by the "apps"
 * integration: the viewer runtime (for spawning the 3D viewer) and the Python
 * interpreter (for running the cad skill scripts).
 *
 * Primary source is the registered `cad-harness` plugin dir
 * (`~/Documents/apps/cad_project/cad_plugins/cad-harness`, listed in
 * `~/.coderix/plugin-registry.json`). Falls back to the legacy `cad_harness`
 * checkout (`CAD_HARNESS_PATH` env, then `~/Documents/apps/cad_project/cad_harness`)
 * when no such plugin is registered.
 *
 * The two layouts differ:
 *   plugin:  <root>/skills, <root>/.env
 *   legacy:  <root>/claude_dir/skills, <root>/.env
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPluginRegistry } from '../../../../packages/coderix-core/src/plugins/registry.js';

function legacyRoot(): string {
  return path.join(os.homedir(), 'Documents', 'apps', 'cad_project', 'cad_harness');
}

/** The cad-harness root: registered plugin dir first, then override/legacy. */
export function resolveCadHarnessRoot(): string {
  for (const entry of readPluginRegistry()) {
    if (entry.name === 'cad-harness' || path.basename(entry.path) === 'cad-harness') {
      return entry.path;
    }
  }
  const override = process.env.CAD_HARNESS_PATH?.trim();
  if (override) return override;
  return legacyRoot();
}

/** True when the root uses the plugin layout (`skills/`) vs legacy (`claude_dir/skills/`). */
function isPluginLayout(root: string): boolean {
  return existsSync(path.join(root, 'skills')) && !existsSync(path.join(root, 'claude_dir'));
}

function skillsRoot(root: string): string {
  return isPluginLayout(root) ? path.join(root, 'skills') : path.join(root, 'claude_dir', 'skills');
}

/** cad-harness's vendored skills root — every skill is a subdir of it. */
export function resolveCadSkillsRoot(): string {
  return skillsRoot(resolveCadHarnessRoot());
}

/** cad-harness's vendored `cad` skill (SKILL.md + scripts). */
export function resolveCadSkillDir(): string {
  return path.join(resolveCadSkillsRoot(), 'cad');
}

/** cad-harness's vendored `cad-viewer` skill (the 3D viewer runtime). */
export function resolveCadViewerDir(): string {
  return path.join(resolveCadSkillsRoot(), 'cad-viewer');
}

/** The scripts/viewer package dir the viewer is launched from. */
export function resolveCadViewerScriptDir(): string {
  return path.join(resolveCadViewerDir(), 'scripts', 'viewer');
}

/**
 * Python interpreter with build123d/OCP/cadgen installed. Prefers an explicit
 * `CAD_PYTHON` env var, then the value recorded in the harness `.env`.
 * Empty string means "let the viewer auto-discover" (the shim does venv +
 * system discovery itself).
 */
export function resolveCadPython(): string {
  const fromEnv = process.env.CAD_PYTHON?.trim();
  if (fromEnv) return fromEnv;

  try {
    const content = readFileSync(path.join(resolveCadHarnessRoot(), '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*CAD_PYTHON\s*=\s*(.+?)\s*$/);
      if (m) return m[1].trim();
    }
  } catch {
    // No .env — let the viewer auto-discover.
  }
  return '';
}
