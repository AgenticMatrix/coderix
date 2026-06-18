/**
 * Memory directory path resolution and management.
 *
 * Resolution order:
 *   1. CODERIX_MEMORY_DIR env var (explicit override)
 *   2. <configDir>/projects/<sanitized-git-root>/memory/
 *
 * Where configDir is ~/.coderix (matching the rest of the Coderix ecosystem).
 */

import { existsSync, mkdirSync } from 'fs';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, join, normalize, sep } from 'path';

import { findCanonicalGitRoot } from '../utils/worktree.js';

// ---------------------------------------------------------------------------
// Path sanitization for project slug
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path into a filesystem-safe slug.
 *
 * Strips the home directory prefix if present, replaces path separators
 * with hyphens, removes consecutive separators, and strips non-alphanumeric
 * characters except hyphens and underscores.
 *
 * Example: /Users/jane/my-project → Users-jane-my-project
 */
export function sanitizePath(input: string): string {
  const normalized = normalize(input).replace(/[/\\]+$/, '');
  const home = homedir();

  // Strip home directory prefix for shorter slugs
  let slug = normalized;
  if (normalized.startsWith(home + sep)) {
    slug = normalized.slice(home.length + 1);
  } else if (normalized.startsWith(home)) {
    slug = normalized.slice(home.length);
  }

  // Replace path separators with hyphens
  slug = slug.replace(/[/\\]/g, '-');

  // Remove leading/trailing hyphens
  slug = slug.replace(/^-+|-+$/g, '');

  // Collapse consecutive hyphens
  slug = slug.replace(/-{2,}/g, '-');

  // Strip characters that aren't alphanumeric, hyphen, or underscore
  slug = slug.replace(/[^a-zA-Z0-9_-]/g, '');

  // Ensure non-empty
  if (slug.length === 0) {
    slug = 'root';
  }

  // Cap length to prevent path-too-long issues
  const MAX_SLUG_LENGTH = 200;
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH);
  }

  return slug;
}

// ---------------------------------------------------------------------------
// Config directory
// ---------------------------------------------------------------------------

/** Returns the Coderix config home directory (~/.coderix). */
export function getConfigDir(): string {
  // Respect CODERIX_CONFIG_DIR if set
  if (process.env.CODERIX_CONFIG_DIR) {
    return process.env.CODERIX_CONFIG_DIR;
  }
  return join(homedir(), '.coderix');
}

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

/**
 * Returns the canonical project root for memory scoping.
 * Uses findCanonicalGitRoot (resolves worktrees to the main repo),
 * falling back to the current working directory.
 */
export function getProjectRoot(cwd: string = process.cwd()): string {
  return findCanonicalGitRoot(cwd) ?? cwd;
}

// ---------------------------------------------------------------------------
// Memory directory resolution
// ---------------------------------------------------------------------------

/**
 * Returns the auto-memory directory path for a project.
 *
 * Shape: <configDir>/projects/<slug>/memory/
 *
 * Env override: CODERIX_MEMORY_DIR takes precedence.
 */
export function getMemoryDir(cwd: string = process.cwd()): string {
  if (process.env.CODERIX_MEMORY_DIR) {
    const dir = process.env.CODERIX_MEMORY_DIR;
    return dir.endsWith(sep) ? dir : dir + sep;
  }

  const projectRoot = getProjectRoot(cwd);
  const slug = sanitizePath(projectRoot);
  return join(getConfigDir(), 'projects', slug, 'memory') + sep;
}

/** Returns the MEMORY.md entrypoint path for a project. */
export function getMemoryIndexPath(cwd: string = process.cwd()): string {
  return join(getMemoryDir(cwd), 'MEMORY.md');
}

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

/**
 * Ensure the memory directory exists (idempotent).
 *
 * Creates the full parent chain — callers can Write directly without
 * checking existence or calling mkdir themselves.
 *
 * Uses sync mkdir for simplicity in prompt-building contexts;
 * FsOperations.mkdirRecursive semantics: swallows EEXIST.
 */
export function ensureMemoryDirExists(cwd: string = process.cwd()): string {
  const dir = getMemoryDir(cwd);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // EACCES/EPERM/EROFS — surface to caller
    throw new Error(
      `Cannot create memory directory at ${dir}. Check permissions.`,
    );
  }

  return dir;
}

/** Async variant for non-sync contexts. */
export async function ensureMemoryDirExistsAsync(
  cwd: string = process.cwd(),
): Promise<string> {
  const dir = getMemoryDir(cwd);

  try {
    await mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    const code =
      err instanceof Error && 'code' in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === 'EEXIST') {
      return dir; // Already exists — fine
    }
    throw new Error(
      `Cannot create memory directory at ${dir}: ${String(err)}`,
    );
  }

  return dir;
}

// ---------------------------------------------------------------------------
// Path predicates
// ---------------------------------------------------------------------------

/**
 * Check if an absolute path is within the auto-memory directory.
 * SECURITY: Normalizes to prevent path-traversal bypasses via .. segments.
 */
export function isAutoMemPath(absolutePath: string, cwd: string = process.cwd()): boolean {
  const normalized = normalize(absolutePath);
  const memDir = getMemoryDir(cwd);
  return normalized.startsWith(memDir);
}

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

/**
 * Whether the auto-memory system is enabled.
 *
 * Priority chain (first defined wins):
 *   1. CODERIX_MEMORY_ENABLED env var (1/true → ON, 0/false → OFF)
 *   2. CODERIX_DISABLE_MEMORY env var (1/true → OFF)
 *   3. CoderSettings.memory.enabled
 *   4. Default: OFF (opt-in for now)
 */
export function isMemoryEnabled(): boolean {
  const enabled = process.env.CODERIX_MEMORY_ENABLED;
  if (enabled === 'true' || enabled === '1') return true;
  if (enabled === 'false' || enabled === '0') return false;

  const disabled = process.env.CODERIX_DISABLE_MEMORY;
  if (disabled === 'true' || disabled === '1') return false;

  // Check settings.json via a lazily-imported config — for now,
  // just check if the memory directory exists as an implicit opt-in.
  // Full settings integration comes in Phase 2.
  const memDir = getMemoryDir();
  try {
    return existsSync(memDir) || existsSync(join(memDir, '..'));
  } catch {
    return false;
  }
}
