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
 *
 * This module scans those roots and returns the minimal listing (name +
 * description) the composer's skill picker needs. It is intentionally
 * dependency-free: a small frontmatter reader extracts the two fields we show,
 * matching the simple `key: value` shape SKILL.md files use.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SkillInfo {
  name: string;
  description: string;
  source: 'user' | 'project' | 'plugin';
}

const SKILL_FILE = 'SKILL.md';

/** Discovery priority — higher wins when the same skill name is found in
 *  multiple roots (matches the CLI's project > user > plugin shadowing). */
const SOURCE_PRIORITY: Record<SkillInfo['source'], number> = {
  plugin: 1,
  user: 2,
  project: 3,
};

/**
 * List all discoverable Claude Code skills for a given working directory.
 * Names are deduplicated; on collision the higher-priority source wins.
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

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

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

/** Insert a skill into the map, honoring source priority on name collision. */
function registerSkill(byName: Map<string, SkillInfo>, skill: SkillInfo): void {
  const existing = byName.get(skill.name);
  if (!existing || SOURCE_PRIORITY[skill.source] >= SOURCE_PRIORITY[existing.source]) {
    byName.set(skill.name, skill);
  }
}
