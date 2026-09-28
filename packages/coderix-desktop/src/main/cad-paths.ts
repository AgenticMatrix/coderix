/**
 * CAD paths — resolve the cad_harness source locations reused by the "apps"
 * integration: the skill directories (for installation) and the cad-viewer
 * runtime (for spawning the 3D viewer).
 *
 * Everything defaults off the user's cad_harness checkout, overridable via
 * `CAD_HARNESS_PATH` so the integration isn't pinned to one machine.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveCadHarnessRoot(): string {
  const override = process.env.CAD_HARNESS_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), 'Documents', 'apps', 'cad_project', 'cad_harness');
}

/** cad_harness's vendored `cad` skill (SKILL.md + scripts). */
export function resolveCadSkillDir(): string {
  return path.join(resolveCadHarnessRoot(), 'claude_dir', 'skills', 'cad');
}

/** cad_harness's vendored `cad-viewer` skill (the 3D viewer runtime). */
export function resolveCadViewerDir(): string {
  return path.join(resolveCadHarnessRoot(), 'claude_dir', 'skills', 'cad-viewer');
}

/** The scripts/viewer package dir the viewer is launched from. */
export function resolveCadViewerScriptDir(): string {
  return path.join(resolveCadViewerDir(), 'scripts', 'viewer');
}

/**
 * Python interpreter with build123d/OCP/cadgen installed. Prefers an explicit
 * `CAD_PYTHON` env var, then the value recorded in cad_harness's `.env`.
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

/**
 * Export the CAD toolchain paths as env vars so the in-process engine's bash
 * tool (and any skill scripts it runs) can resolve them. The `cad` skill's
 * launchers shell out to build123d/OCP, so `CAD_PYTHON` in particular must be
 * the interpreter that has those installed.
 */
export function applyCadEnv(): void {
  const python = resolveCadPython();
  if (python) process.env.CAD_PYTHON = python;
  process.env.CAD_SKILL_DIR = resolveCadSkillDir();
  process.env.CAD_VIEWER_DIR = resolveCadViewerDir();
}
