/**
 * Plan file management — slug generation, read/write, path resolution.
 *
 * Plan files are stored as Markdown files in ~/.coderix/plans/ with
 * word-slug filenames (e.g. "brave-tiger.md").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLANS_DIR = join(homedir(), '.coderix', 'plans');

const ADJECTIVES = [
  'brave', 'calm', 'eager', 'happy', 'kind', 'lucky', 'proud', 'swift',
  'bright', 'clear', 'fresh', 'sharp', 'smart', 'warm', 'bold', 'keen',
];

const NOUNS = [
  'tiger', 'eagle', 'falcon', 'dolphin', 'panda', 'raven', 'otter', 'wolf',
  'hawk', 'fox', 'bear', 'lion', 'deer', 'dove', 'crane', 'lark',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensurePlansDir(): string {
  if (!existsSync(PLANS_DIR)) {
    mkdirSync(PLANS_DIR, { recursive: true });
  }
  return PLANS_DIR;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate a random word-slug filename stem (e.g. "brave-tiger"). */
export function generatePlanSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

/**
 * Resolve the absolute path for a plan file.
 *
 * @param slug - Word-slug filename stem (e.g. "brave-tiger")
 * @param agentId - For sub-agents, appends "-agent-<agentId>" suffix
 */
export function getPlanFilePath(slug: string, agentId?: string): string {
  ensurePlansDir();
  const filename = agentId ? `${slug}-agent-${agentId}.md` : `${slug}.md`;
  return join(PLANS_DIR, filename);
}

/** Read plan file content. Returns null if the file doesn't exist. */
export function getPlan(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Write plan content to a file. Creates parent directory if needed. */
export function writePlan(content: string, filePath: string): void {
  ensurePlansDir();
  writeFileSync(filePath, content, 'utf-8');
}

/** Get the plans directory path. */
export function getPlansDir(): string {
  return PLANS_DIR;
}
