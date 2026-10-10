/**
 * cad-control MCP — environment resolution.
 *
 * Resolves the cad_harness checkout + Python interpreter so the MCP tools can
 * drive the `cad` skill scripts. Mirrors the desktop's `cad-paths.ts` (which
 * core cannot import); the desktop bootstrap writes the same values into the
 * server's `env` so they stay consistent. Everything is overridable via
 * `CAD_HARNESS_PATH` / `CAD_PYTHON`.
 */

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveCadHarnessRoot(): string {
  const override = process.env.CAD_HARNESS_PATH?.trim();
  if (override) return override;
  return path.join(os.homedir(), 'Documents', 'apps', 'cad_project', 'cad_harness');
}

/** cad_harness's vendored `cad` skill dir (scripts/). */
export function resolveCadSkillDir(): string {
  return path.join(resolveCadHarnessRoot(), 'claude_dir', 'skills', 'cad');
}

/** Python interpreter with build123d/OCP/cadgen installed ('' = auto-discover). */
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
    // no .env — fall back to `python`
  }
  return 'python';
}

/** The cad-viewer's local HTTP control base (the shared on-screen viewer). */
export const CAD_VIEWER_BASE = 'http://127.0.0.1:3245';

/** Build the viewer URL for an artifact: path = absolute dir, file= = relative path. */
export function buildViewerUrl(workspaceDir: string, fileRel: string): string {
  const abs = workspaceDir.replace(/\\/g, '/');
  const pathPart = abs.startsWith('/') ? abs : `/${abs}`;
  const base = `${CAD_VIEWER_BASE}${pathPart}`;
  return fileRel ? `${base}?file=${encodeURIComponent(fileRel)}` : base;
}

/** Whether the cad_harness `cad` skill dir exists (tools no-op gracefully otherwise). */
export function hasCadSkill(): boolean {
  return existsSync(path.join(resolveCadSkillDir(), 'scripts'));
}
