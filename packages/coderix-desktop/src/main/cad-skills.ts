/**
 * CAD skills installer — makes cad_harness's vendored CAD skills available to
 * Coderix's engine by symlinking them into `~/.coderix/skills/` (the in-process
 * engine's discovery root).
 *
 * cad_harness exposes its whole `claude_dir/skills/` directory as a plugin
 * (`skills: "./skills/"`), so a cad_harness conversation can invoke any of them
 * (cad, cad-viewer, cad-plan, cad-component-generation, step-parts, urdf, …).
 * To align, we mirror that directory wholesale rather than curating a list — the
 * set stays in sync as cad_harness adds or removes skills.
 *
 * Idempotent: an existing entry (symlink or real dir) is never touched, so
 * user customizations or a prior copy are preserved. Symlinks keep the skills
 * in sync with the cad_harness checkout instead of going stale.
 */

import { lstatSync, mkdirSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCadSkillDir, resolveCadSkillsRoot, resolveCadViewerDir } from './cad-paths.js';

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate cad_harness's vendored skills: every non-dot subdir of
 * `claude_dir/skills/` that contains a `SKILL.md`, sorted by name. This is the
 * exact set cad_harness's own plugin advertises, so a cad-harness conversation
 * sees the same skills. Returns `[]` when the skills root can't be read (e.g. a
 * partial checkout) — callers fall back to the two core skills.
 */
export function listCadSkills(): Array<{ name: string; source: string }> {
  const root = resolveCadSkillsRoot();
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .filter((name) => existsSync(path.join(root, name, 'SKILL.md')))
    .sort()
    .map((name) => ({ name, source: path.join(root, name) }));
}

/**
 * The skill names a cad-harness conversation should expose (the engine's
 * per-session skill filter). Mirrors {@link listCadSkills}, guaranteed to
 * include the two core skills (`cad`, `cad-viewer`) even on a partial checkout
 * where the skills root is missing.
 */
export function listCadSkillNames(): string[] {
  const names = listCadSkills().map((s) => s.name);
  for (const core of ['cad', 'cad-viewer']) {
    if (!names.includes(core)) names.push(core);
  }
  return names.sort();
}

export function installCadSkills(): void {
  const skillsDir = path.join(os.homedir(), '.coderix', 'skills');
  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch {
    // best-effort
  }

  // Mirror the whole vendored skills root; fall back to the two core skills when
  // it can't be enumerated (partial checkout with only cad/cad-viewer present).
  let targets = listCadSkills();
  if (targets.length === 0) {
    targets = [
      { name: 'cad', source: resolveCadSkillDir() },
      { name: 'cad-viewer', source: resolveCadViewerDir() },
    ];
  }

  for (const { name, source } of targets) {
    const dest = path.join(skillsDir, name);
    if (pathExists(dest)) continue;
    if (!existsSync(source)) {
      console.warn(`[CadSkills] source missing for ${name}: ${source}`);
      continue;
    }
    try {
      symlinkSync(source, dest, 'dir');
      console.log(`[CadSkills] linked ${name} -> ${source}`);
    } catch (err) {
      console.warn(`[CadSkills] failed to link ${name}:`, err);
    }
  }
}
