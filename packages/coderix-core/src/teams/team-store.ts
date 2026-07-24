/**
 * Team store — persistence layer for team configs.
 *
 * Teams are stored at <sessionDir>/teams/{team-name}/config.json.
 * Uses proper-lockfile for concurrent access.
 */

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

import type { TeamConfig, TeamMember } from './types.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function sanitize(name: string): string {
  return name
    .replace(/[\/\\\0\n\r\t:*?"<>|]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim() || 'unnamed';
}

export function teamDir(sessionDir: string, teamName: string): string {
  return join(sessionDir, 'teams', sanitize(teamName));
}

function configPath(sessionDir: string, teamName: string): string {
  return join(teamDir(sessionDir, teamName), 'config.json');
}

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
};

/**
 * Ensure a lock file exists before locking it.
 * proper-lockfile requires the file to already exist.
 */
async function ensureLockFile(lockPath: string): Promise<void> {
  try {
    await writeFile(lockPath, '', { flag: 'wx' });
  } catch {
    // File already exists — fine
  }
}

async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, '.lock');
  await ensureLockFile(lockPath);
  const release = await lockfile.lock(lockPath, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadTeamConfig(
  sessionDir: string,
  teamName: string,
): Promise<TeamConfig | null> {
  try {
    const raw = await readFile(configPath(sessionDir, teamName), 'utf-8');
    return JSON.parse(raw) as TeamConfig;
  } catch {
    return null;
  }
}

export async function saveTeamConfig(
  sessionDir: string,
  config: TeamConfig,
): Promise<void> {
  const dir = teamDir(sessionDir, config.name);
  await withLock(dir, async () => {
    await writeFile(configPath(sessionDir, config.name), JSON.stringify(config, null, 2), 'utf-8');
  });
}

export async function addTeamMember(
  sessionDir: string,
  teamName: string,
  member: TeamMember,
): Promise<TeamConfig> {
  const dir = teamDir(sessionDir, teamName);

  return withLock(dir, async () => {
    const config = await loadTeamConfig(sessionDir, teamName);
    if (!config) {
      throw new Error(`Team '${teamName}' not found`);
    }
    config.members.push(member);
    await writeFile(configPath(sessionDir, teamName), JSON.stringify(config, null, 2), 'utf-8');
    return config;
  });
}

export async function updateTeamMember(
  sessionDir: string,
  teamName: string,
  agentId: string,
  patch: Partial<TeamMember>,
): Promise<TeamConfig | null> {
  const dir = teamDir(sessionDir, teamName);

  return withLock(dir, async () => {
    const config = await loadTeamConfig(sessionDir, teamName);
    if (!config) return null;

    const member = config.members.find(m => m.agentId === agentId);
    if (!member) return null;

    Object.assign(member, patch);
    await writeFile(configPath(sessionDir, teamName), JSON.stringify(config, null, 2), 'utf-8');
    return config;
  });
}

export async function listTeams(sessionDir: string): Promise<string[]> {
  const teamsDir = join(sessionDir, 'teams');
  try {
    const entries = await readdir(teamsDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

export async function deleteTeam(sessionDir: string, teamName: string): Promise<void> {
  const dir = teamDir(sessionDir, teamName);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Already gone — fine
  }
}

export { sanitize as sanitizeTeamName };
