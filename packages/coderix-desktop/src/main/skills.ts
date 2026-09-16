/**
 * skills.ts — Claude Code skill discovery for the desktop app.
 *
 * The desktop's default engine is `claude-code` (the real `claude` CLI spawned
 * via @anthropic-ai/claude-agent-sdk). Its skills are `SKILL.md` files under
 * the same discovery roots the CLI scans:
 *
 *   project: <cwd>/.claude/skills/<name>/SKILL.md
 *   user:    ~/.claude/skills/<name>/SKILL.md
 *   plugin:  ~/.claude/plugins/<plugin>/skills/<name>/SKILL.md
 *   custom:  any directory the user adds in settings (`custom_skill_dirs`),
 *            each a folder of `<name>/SKILL.md` — same layout as the user root.
 *
 * This module scans those roots and returns the minimal listing (name +
 * description) the composer's skill picker needs. It is intentionally
 * dependency-free: a small frontmatter reader extracts the two fields we show,
 * matching the simple `key: value` shape SKILL.md files use.
 *
 * Custom directories aren't visible to the `claude` CLI on their own (the CLI
 * only discovers the three fixed roots + plugins). To make their skills
 * loadable we materialize a managed "shim" plugin under
 * `~/.coderix/custom-skills/` whose `skills/<name>` entries are symlinks into
 * the user's custom directories, then load that shim via the SDK's `plugins`
 * option (see claude-code-engine.ts).
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { loadSettings, saveSettings } from '@coderix/core';

export interface SkillInfo {
  name: string;
  description: string;
  source: 'user' | 'project' | 'plugin' | 'custom';
}

const SKILL_FILE = 'SKILL.md';

/** Discovery priority — higher wins when the same skill name is found in
 *  multiple roots (matches the CLI's project > user > plugin shadowing, plus a
 *  top "custom" tier so a user-added skill overrides built-ins). */
const SOURCE_PRIORITY: Record<SkillInfo['source'], number> = {
  plugin: 1,
  user: 2,
  project: 3,
  custom: 4,
};

/** Managed plugin dir whose `skills/*` symlinks expose custom skill dirs to the CLI. */
export const CUSTOM_SKILL_SHIM_DIR = join(homedir(), '.coderix', 'custom-skills');

/**
 * List all discoverable Claude Code skills for a given working directory.
 * Names are deduplicated; on collision the higher-priority source wins (equal
 * priority = first-seen wins, so the first-listed custom dir shadows later ones).
 */
export function listAvailableSkills(cwd: string): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();

  const roots: Array<{ dir: string; source: SkillInfo['source'] }> = [
    { dir: join(homedir(), '.claude', 'plugins'), source: 'plugin' },
    { dir: join(homedir(), '.claude', 'skills'), source: 'user' },
    { dir: join(cwd, '.claude', 'skills'), source: 'project' },
  ];

  for (const { dir, source } of roots) {
    if (!existsSync(dir)) continue;

    if (source === 'plugin') {
      // Each plugin directory may contain a `skills/` subdirectory.
      for (const plugin of listDirectories(dir)) {
        const skillsDir = join(dir, plugin, 'skills');
        if (existsSync(skillsDir)) {
          for (const skill of scanSkillDir(skillsDir, source)) {
            registerSkill(byName, skill);
          }
        }
      }
    } else {
      for (const skill of scanSkillDir(dir, source)) {
        registerSkill(byName, skill);
      }
    }
  }

  // Custom directories — scanned last so they shadow built-ins; equal-priority
  // (custom vs custom) keeps the first-listed directory's skill.
  for (const dir of readCustomSkillDirs()) {
    if (!existsSync(dir)) continue;
    for (const skill of scanSkillDir(dir, 'custom')) {
      registerSkill(byName, skill);
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Coderix (in-process) engine skill roots
// ---------------------------------------------------------------------------

const CODERIX_SKILLS_DIR = join(homedir(), '.coderix', 'skills');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');

/**
 * The directories the in-process Coderix engine scans for skills. This mirrors
 * what the core SkillLoader loads by default (bundled `~/.coderix/skills/` plus
 * Claude Code's `~/.claude/skills/`) and appends the user's custom directories
 * so a selected custom skill resolves for the built-in engine too.
 */
export function coderixSkillDirs(): string[] {
  return [CODERIX_SKILLS_DIR, CLAUDE_SKILLS_DIR, ...readCustomSkillDirs()];
}

/**
 * List the skills the Coderix (in-process) engine can actually load — the same
 * roots as `coderixSkillDirs()`. Used by the skill picker when the built-in
 * engine is active so the picker matches what the engine will inject.
 */
export function listCoderixSkills(): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const dir of coderixSkillDirs()) {
    if (!existsSync(dir)) continue;
    for (const skill of scanSkillDir(dir, 'user')) {
      registerSkill(byName, skill);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Custom directory management (persisted to ~/.coderix/settings.json)
// ---------------------------------------------------------------------------

/** Custom skill directories as currently persisted, sanitized to non-empty strings. */
function readCustomSkillDirs(): string[] {
  const dirs = loadSettings().custom_skill_dirs;
  if (!Array.isArray(dirs)) return [];
  return dirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
}

/** Persist the custom directory list back to settings.json. */
function persistCustomSkillDirs(dirs: string[]): void {
  const settings = loadSettings();
  settings.custom_skill_dirs = dirs;
  saveSettings(settings);
}

export function listCustomSkillDirs(): string[] {
  return readCustomSkillDirs();
}

/** Add a directory (canonicalized, de-duplicated). Returns the updated list. */
export function addCustomSkillDir(path: string): string[] {
  const dirs = readCustomSkillDirs();
  const next = resolve(path);
  if (!dirs.includes(next)) dirs.push(next);
  persistCustomSkillDirs(dirs);
  refreshCustomSkillShim();
  return dirs;
}

/** Remove a directory by its exact (canonical) path. Returns the updated list. */
export function removeCustomSkillDir(path: string): string[] {
  const dirs = readCustomSkillDirs().filter((d) => d !== path);
  persistCustomSkillDirs(dirs);
  refreshCustomSkillShim();
  return dirs;
}

/**
 * Rebuild the managed shim plugin (`~/.coderix/custom-skills/skills/<name>`)
 * so its symlinks mirror the current custom directories. First-listed dir wins
 * on name collision; stale links are removed. Never throws — a broken custom
 * skill must not take down a turn.
 */
export function refreshCustomSkillShim(): void {
  try {
    const skillsDir = join(CUSTOM_SKILL_SHIM_DIR, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Desired link set: <name> -> <customDir>/<name> for dirs that hold a SKILL.md.
    const desired = new Map<string, string>();
    for (const dir of readCustomSkillDirs()) {
      for (const name of listDirectories(dir)) {
        if (!existsSync(join(dir, name, SKILL_FILE))) continue;
        if (!desired.has(name)) desired.set(name, join(dir, name));
      }
    }

    // Drop stale entries that are no longer desired.
    for (const entry of listDirectories(skillsDir)) {
      if (desired.has(entry)) continue;
      removeShimEntry(join(skillsDir, entry));
    }

    // (Re)create symlinks.
    for (const [name, target] of desired) {
      const linkPath = join(skillsDir, name);
      removeShimEntry(linkPath);
      try {
        symlinkSync(target, linkPath, 'dir');
      } catch {
        /* ignore — target may have vanished mid-scan */
      }
    }
  } catch {
    /* ignore */
  }
}

/** Remove a shim entry — a symlink via unlink, anything else via rm. */
function removeShimEntry(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
    else rmSync(path, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Skill file scanning
// ---------------------------------------------------------------------------

/** Read every `<name>/SKILL.md` under a skills directory. */
function scanSkillDir(skillsDir: string, source: SkillInfo['source']): SkillInfo[] {
  const skills: SkillInfo[] = [];
  for (const name of listDirectories(skillsDir)) {
    const file = join(skillsDir, name, SKILL_FILE);
    if (!existsSync(file)) continue;
    const info = parseSkillFile(file, source);
    if (info) skills.push(info);
  }
  return skills;
}

/** Parse name + description from a SKILL.md file's YAML frontmatter. */
function parseSkillFile(file: string, source: SkillInfo['source']): SkillInfo | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return null;
  }

  const { name, description } = readFrontmatter(raw);
  if (!name) return null;

  return { name, description: description || '', source };
}

/**
 * Extract `name` and `description` from a SKILL.md frontmatter block (the text
 * between the first two `---` lines). Returns empty strings for missing keys.
 */
function readFrontmatter(raw: string): { name: string; description: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: '', description: '' };

  const fm: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') break;
    fm.push(lines[i]!);
  }

  let name = '';
  let description = '';
  for (const line of fm) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = unquote(m[2]!.trim());
    if (key === 'name' && !name) name = value;
    else if (key === 'description' && !description) description = value;
  }
  return { name, description };
}

/** Strip surrounding single/double quotes from a YAML scalar. */
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** List subdirectory names under a path ([] when missing or unreadable). */
function listDirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => {
        try {
          return statSync(join(dir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** Insert a skill into the map, honoring source priority on name collision
 *  (strictly-greater so equal-priority custom dirs keep the first-seen entry). */
function registerSkill(byName: Map<string, SkillInfo>, skill: SkillInfo): void {
  const existing = byName.get(skill.name);
  if (!existing || SOURCE_PRIORITY[skill.source] > SOURCE_PRIORITY[existing.source]) {
    byName.set(skill.name, skill);
  }
}
