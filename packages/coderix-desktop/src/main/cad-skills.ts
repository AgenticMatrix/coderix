/**
 * CAD skills installer — makes cad_harness's vendored `cad` + `cad-viewer`
 * skills available to Coderix's engine by symlinking them into
 * `~/.coderix/skills/` (the in-process engine's discovery root).
 *
 * Idempotent: an existing entry (symlink or real dir) is never touched, so
 * user customizations or a prior copy are preserved. Symlinks keep the skills
 * in sync with the cad_harness checkout instead of going stale.
 */

import { lstatSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCadSkillDir, resolveCadViewerDir } from './cad-paths.js';

function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function installCadSkills(): void {
  const skillsDir = path.join(os.homedir(), '.coderix', 'skills');
  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch {
    // best-effort
  }

  const targets: Array<[name: string, source: string]> = [
    ['cad', resolveCadSkillDir()],
    ['cad-viewer', resolveCadViewerDir()],
  ];

  for (const [name, source] of targets) {
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
