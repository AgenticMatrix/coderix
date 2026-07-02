/**
 * Worktree utilities — git worktree creation, removal, and lifecycle
 * for agent isolation and session isolation.
 *
 * Two-layer design:
 *   1. Agent worktree  — lightweight, no global state, returns a path
 *   2. Session worktree — full lifecycle with cwd switching and persistence
 *
 * All git operations use execFileSync for deterministic, synchronous execution.
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  stat,
  utimes,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { HookManager } from '../hooks/manager.js';

// ---------------------------------------------------------------------------
// Slug validation
// ---------------------------------------------------------------------------

const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const MAX_WORKTREE_SLUG_LENGTH = 64;

/**
 * Validate a worktree slug to prevent path traversal and directory escape.
 * Each "/"-separated segment must be non-empty, contain only [a-zA-Z0-9._-],
 * and not be "." or "..".
 */
export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(
      `Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    );
  }
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `Invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      );
    }
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Env vars to prevent git from prompting for credentials. */
const GIT_NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
};

/**
 * Run git with args in the given cwd. Returns stdout trimmed, or throws on non-zero exit.
 */
function git(args: string[], cwd: string): string {
  const result = execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    env: GIT_NO_PROMPT_ENV,
  });
  return result.trim();
}

/**
 * Run git, returning { code, stdout, stderr } — never throws.
 */
function gitNoThrow(
  args: string[],
  cwd: string,
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: GIT_NO_PROMPT_ENV,
    });
    return { code: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: (typeof e.stdout === 'string' ? e.stdout : '').trim(),
      stderr: (typeof e.stderr === 'string' ? e.stderr : '').trim(),
    };
  }
}

// ---------------------------------------------------------------------------
// Git root discovery
// ---------------------------------------------------------------------------

/**
 * Find the nearest git root by walking up from startPath.
 */
export function findGitRoot(startPath: string): string | null {
  let dir = startPath;
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Find the CANONICAL git repository root, resolving through worktrees.
 *
 * Unlike findGitRoot, which returns the worktree directory (where the `.git`
 * file lives), this returns the MAIN repository's working directory. This
 * ensures all worktrees of the same repo map to the same project identity
 * and agent worktrees always land in the main repo's .claude/worktrees/.
 */
export function findCanonicalGitRoot(startPath: string): string | null {
  const root = findGitRoot(startPath);
  if (!root) return null;

  const gitPath = join(root, '.git');

  // If .git is a file (worktree pointer), parse it to find the main repo
  if (existsSync(gitPath) && !statSync(gitPath).isDirectory()) {
    try {
      const content = readFileSync(gitPath, 'utf-8').trim();
      // Format: "gitdir: /path/to/main/.git/worktrees/name"
      const match = content.match(/^gitdir:\s+(.+)$/);
      if (match?.[1]) {
        const gitDir = match[1];
        // Walk up from .git/worktrees/name:
        // name → worktrees → .git → main working dir (or bare repo)
        const worktreesDir = dirname(gitDir); // .../main/.git/worktrees
        const dotGitDir = dirname(worktreesDir); // .../main/.git
        if (basename(dotGitDir) === '.git') {
          return dirname(dotGitDir); // .../main — main working tree
        }
        // Bare repo fallback
        return dotGitDir;
      }
    } catch {
      return root;
    }
  }

  return root;
}

// ---------------------------------------------------------------------------
// Path and branch naming
// ---------------------------------------------------------------------------

function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.claude', 'worktrees');
}

/**
 * Flatten nested slugs (`user/feature` → `user+feature`) for branch names
 * and directory paths. `+` is valid in git branch names and filesystem paths
 * but NOT in the slug-segment allowlist ([a-zA-Z0-9._-]), so the mapping
 * is injective and safe.
 *
 * This avoids git ref D/F conflicts (a file `worktree-user` vs a directory
 * `worktree-user/feature`) and prevents nesting a worktree inside another.
 */
function flattenSlug(slug: string): string {
  return slug.replace(/\//g, '+');
}

export function worktreeBranchName(slug: string): string {
  return `coderix-${flattenSlug(slug)}`;
}

export function worktreePathFor(repoRoot: string, slug: string): string {
  return join(worktreesDir(repoRoot), flattenSlug(slug));
}

// ---------------------------------------------------------------------------
// PR reference parsing
// ---------------------------------------------------------------------------

/**
 * Parse a GitHub PR reference from a string.
 * Accepts GitHub-style PR URLs or `#N` format.
 * Returns the PR number or null if the string is not a recognized PR reference.
 */
export function parsePRReference(input: string): number | null {
  // GitHub-style PR URL: https://<host>/owner/repo/pull/123
  const urlMatch = input.match(
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  );
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10);
  }

  // #N format
  const hashMatch = input.match(/^#(\d+)$/);
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Default branch
// ---------------------------------------------------------------------------

async function getDefaultBranch(repoRoot: string): Promise<string> {
  // Try to get the remote HEAD symref
  const { code, stdout } = gitNoThrow(
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    repoRoot,
  );
  if (code === 0 && stdout) {
    const match = stdout.match(/refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  }

  // Fallback: try common names
  for (const candidate of ['main', 'master']) {
    const { code: c } = gitNoThrow(
      ['rev-parse', '--verify', `origin/${candidate}`],
      repoRoot,
    );
    if (c === 0) return candidate;
  }

  return 'main';
}

// ---------------------------------------------------------------------------
// Read worktree HEAD sha (fast resume path)
// ---------------------------------------------------------------------------

function readWorktreeHeadSha(worktreePath: string): string | null {
  try {
    const dotGitPath = join(worktreePath, '.git');
    if (!existsSync(dotGitPath)) return null;

    // .git is a file in a worktree: "gitdir: /path/to/main/.git/worktrees/name"
    let gitDir: string;
    if (statSync(dotGitPath).isFile()) {
      const content = readFileSync(dotGitPath, 'utf-8').trim();
      const match = content.match(/^gitdir:\s+(.+)$/);
      if (match?.[1]) {
        gitDir = match[1];
      } else {
        return null;
      }
    } else {
      gitDir = dotGitPath;
    }

    const headPath = join(gitDir, 'HEAD');
    if (!existsSync(headPath)) return null;
    const ref = readFileSync(headPath, 'utf-8').trim();

    // Symbolic ref: "ref: refs/heads/branch-name"
    if (ref.startsWith('ref: ')) {
      const refPath = join(gitDir, ref.slice(5));
      if (!existsSync(refPath)) return null;
      return readFileSync(refPath, 'utf-8').trim();
    }

    // Detached HEAD — the file content IS the sha
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Create / get worktree
// ---------------------------------------------------------------------------

export interface WorktreeCreateOptions {
  /** Enable sparse checkout with the given cone-mode paths. */
  sparsePaths?: string[];
  /** Directories to symlink from the main repo (e.g. 'node_modules'). */
  symlinkDirectories?: string[];
  /** GitHub PR number — fetches pull/<N>/head from origin as the base. */
  prNumber?: number;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  worktreeBranch: string;
  headCommit: string;
  baseBranch?: string;
  existed: boolean;
}

/**
 * Create a git worktree or resume one that already exists.
 *
 * When `options.sparsePaths` is set, the worktree is created with
 * `--no-checkout`, then sparse-checkout is configured in cone mode
 * and HEAD is checked out. If either step fails, the broken worktree
 * is torn down before propagating the error.
 */
export async function getOrCreateWorktree(
  repoRoot: string,
  slug: string,
  options?: WorktreeCreateOptions,
): Promise<WorktreeCreateResult> {
  const worktreePath = worktreePathFor(repoRoot, slug);
  const worktreeBranch = worktreeBranchName(slug);

  // Fast resume: if worktree directory already exists, skip creation
  const existingHead = readWorktreeHeadSha(worktreePath);
  if (existingHead) {
    return {
      worktreePath,
      worktreeBranch,
      headCommit: existingHead,
      existed: true,
    };
  }

  // Ensure worktrees directory exists
  const dir = worktreesDir(repoRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // ── PR-based worktree ───────────────────────────────────────────────
  if (options?.prNumber) {
    const prRef = `pull/${options.prNumber}/head`;
    const { code: prFetchCode, stderr: prFetchStderr } = gitNoThrow(
      ['fetch', 'origin', prRef],
      repoRoot,
    );
    if (prFetchCode !== 0) {
      throw new Error(
        `Failed to fetch PR #${options.prNumber}: ${prFetchStderr.trim() || 'PR may not exist or the repository may not have a remote named "origin"'}`
      );
    }

    const addArgs = ['worktree', 'add'];
    if (options?.sparsePaths?.length) addArgs.push('--no-checkout');
    addArgs.push('-B', worktreeBranch, worktreePath, 'FETCH_HEAD');

    git(addArgs, repoRoot);

    if (options?.sparsePaths?.length) {
      const tearDownAndThrow = (msg: string): never => {
        gitNoThrow(['worktree', 'remove', '--force', worktreePath], repoRoot);
        throw new Error(msg);
      };
      const { code: sparseCode, stderr: sparseErr } = gitNoThrow(
        ['sparse-checkout', 'set', '--cone', '--', ...options.sparsePaths!],
        worktreePath,
      );
      if (sparseCode !== 0) {
        tearDownAndThrow(`Failed to configure sparse-checkout: ${sparseErr}`);
      }
      const { code: coCode, stderr: coErr } = gitNoThrow(
        ['checkout', 'HEAD'],
        worktreePath,
      );
      if (coCode !== 0) {
        tearDownAndThrow(`Failed to checkout sparse worktree: ${coErr}`);
      }
    }

    return {
      worktreePath,
      worktreeBranch,
      headCommit: git(['rev-parse', 'FETCH_HEAD'], repoRoot),
      existed: false,
    };
  }

  // Determine base branch
  const defaultBranch = await getDefaultBranch(repoRoot);
  const originRef = `origin/${defaultBranch}`;

  // Check if origin/<branch> exists locally, skip fetch if it does
  const { code: revCode, stdout: originSha } = gitNoThrow(
    ['rev-parse', originRef],
    repoRoot,
  );
  let baseBranch: string;
  let baseSha: string;

  if (revCode === 0 && originSha) {
    baseBranch = originRef;
    baseSha = originSha;
  } else {
    // Fetch and retry
    const { code: fetchCode } = gitNoThrow(
      ['fetch', 'origin', defaultBranch],
      repoRoot,
    );
    if (fetchCode === 0) {
      const { stdout } = gitNoThrow(['rev-parse', originRef], repoRoot);
      baseBranch = originRef;
      baseSha = stdout || '';
    } else {
      // Fallback to HEAD
      baseBranch = 'HEAD';
      baseSha = git(['rev-parse', 'HEAD'], repoRoot);
    }
  }

  // Build add args — support sparse checkout via --no-checkout
  const sparsePaths = options?.sparsePaths;
  const addArgs = ['worktree', 'add'];
  if (sparsePaths?.length) {
    addArgs.push('--no-checkout');
  }
  // -B (not -b): reset any orphan branch left behind by a removed worktree dir
  addArgs.push('-B', worktreeBranch, worktreePath, baseBranch);

  git(addArgs, repoRoot);

  // ── Sparse checkout setup + tear-down ────────────────────────────
  if (sparsePaths?.length) {
    // Tear-down helper: if sparse-checkout or checkout fail after
    // --no-checkout, the worktree is registered but the working tree
    // is empty. Next run's fast-resume would present it as valid.
    // Remove it before propagating the error.
    const tearDownAndThrow = (msg: string): never => {
      gitNoThrow(
        ['worktree', 'remove', '--force', worktreePath],
        repoRoot,
      );
      throw new Error(msg);
    };

    // Configure sparse-checkout in cone mode
    const { code: sparseCode, stderr: sparseErr } = gitNoThrow(
      ['sparse-checkout', 'set', '--cone', '--', ...sparsePaths],
      worktreePath,
    );
    if (sparseCode !== 0) {
      tearDownAndThrow(`Failed to configure sparse-checkout: ${sparseErr}`);
    }

    // Checkout HEAD to populate the sparse working tree
    const { code: coCode, stderr: coErr } = gitNoThrow(
      ['checkout', 'HEAD'],
      worktreePath,
    );
    if (coCode !== 0) {
      tearDownAndThrow(`Failed to checkout sparse worktree: ${coErr}`);
    }
  }

  return {
    worktreePath,
    worktreeBranch,
    headCommit: baseSha,
    baseBranch,
    existed: false,
  };
}

// ---------------------------------------------------------------------------
// Remove worktree
// ---------------------------------------------------------------------------

/**
 * Remove a worktree and delete its branch. Returns true on success.
 */
export async function removeWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
): Promise<boolean> {
  const repoRoot = gitRoot ?? findCanonicalGitRoot(process.cwd());
  if (!repoRoot) {
    // Fallback: run from current directory
    const { code } = gitNoThrow(
      ['worktree', 'remove', '--force', worktreePath],
      process.cwd(),
    );
    return code === 0;
  }

  const { code: removeCode } = gitNoThrow(
    ['worktree', 'remove', '--force', worktreePath],
    repoRoot,
  );

  if (removeCode !== 0) return false;

  // Delete the temporary branch
  if (worktreeBranch) {
    // Small delay so git can release locks
    await new Promise(resolve => setTimeout(resolve, 100));
    gitNoThrow(['branch', '-D', worktreeBranch], repoRoot);
    // Non-fatal if branch deletion fails — worktree itself is already gone
  }

  return true;
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Check whether a worktree has uncommitted changes or new commits since
 * the given head commit. Returns true if there are changes worth preserving.
 *
 * Checks TWO dimensions:
 *   1. Dirty working tree (git status --porcelain)
 *   2. New commits on the worktree branch since headCommit
 *
 * Fail-closed: if any git command fails, returns true (assume changes exist).
 */
export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  // Check for dirty working tree
  const { code: statusCode, stdout: statusOutput } = gitNoThrow(
    ['status', '--porcelain'],
    worktreePath,
  );
  if (statusCode !== 0) return true;
  if (statusOutput.trim().length > 0) return true;

  // Check for new commits since headCommit
  const { code: revCode, stdout: revOutput } = gitNoThrow(
    ['rev-list', '--count', `${headCommit}..HEAD`],
    worktreePath,
  );
  if (revCode !== 0) return true;
  if (parseInt(revOutput.trim(), 10) > 0) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Post-creation setup
// ---------------------------------------------------------------------------

/**
 * Copy settings.local.json to the worktree's .claude directory so
 * the worktree has access to the user's local settings.
 */
function copyLocalSettings(repoRoot: string, worktreePath: string): void {
  const src = join(repoRoot, '.claude', 'settings.local.json');
  if (!existsSync(src)) return;

  const destDir = join(worktreePath, '.claude');
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  const dest = join(destDir, 'settings.local.json');

  try {
    copyFileSync(src, dest);
  } catch {
    // Best-effort — not fatal if copy fails
  }
}

/**
 * Configure the worktree to use git hooks from the main repository.
 * This fixes .husky and other hook managers that use relative paths.
 *
 * The config value is stored in the shared .git/config (git config without
 * --worktree writes to the common config), shared by all worktrees. Once set,
 * every subsequent worktree create is a no-op — skip the subprocess when the
 * value already matches.
 */
function configureGitHooks(repoRoot: string, worktreePath: string): void {
  const candidates = [join(repoRoot, '.husky'), join(repoRoot, '.git', 'hooks')];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    // Check if hooksPath already matches — skip unnecessary config writes
    const { code: getCode, stdout: currentHooksPath } = gitNoThrow(
      ['config', '--get', 'core.hooksPath'],
      worktreePath,
    );
    if (getCode === 0 && currentHooksPath.trim() === candidate) {
      break; // Already configured correctly
    }

    gitNoThrow(['config', 'core.hooksPath', candidate], worktreePath);
    break;
  }
}

// ---------------------------------------------------------------------------
// Symlink directories
// ---------------------------------------------------------------------------

/**
 * Symlink directories from the main repository to avoid disk bloat.
 * This prevents duplicating large directories like node_modules in worktrees.
 */
async function symlinkLargeDirectories(
  repoRoot: string,
  worktreePath: string,
  dirsToSymlink: string[],
): Promise<void> {
  for (const dir of dirsToSymlink) {
    // Safety: reject path traversal in directory names
    if (dir.includes('..') || dir.startsWith('/')) {
      continue;
    }

    const sourcePath = join(repoRoot, dir);
    const destPath = join(worktreePath, dir);

    try {
      symlinkSync(sourcePath, destPath, 'dir');
    } catch {
      // ENOENT: source doesn't exist yet (skip silently)
      // EEXIST: destination already exists (skip silently)
      // Other errors: skip (non-fatal)
    }
  }
}

// ---------------------------------------------------------------------------
// .worktreeinclude — copy gitignored files into the worktree
// ---------------------------------------------------------------------------

/**
 * Copy gitignored files specified in .worktreeinclude from the base repo to
 * the worktree. The file uses .gitignore syntax — one pattern per line.
 *
 * Only copies files that are BOTH:
 * 1. Matched by a pattern in .worktreeinclude
 * 2. Gitignored (not tracked by git)
 *
 * Uses `git ls-files --others --ignored --exclude-standard --directory` to
 * collapse fully-gitignored directories (node_modules/, .turbo/, etc.) into
 * single entries, avoiding a full tree walk in large repos. If a pattern
 * explicitly targets a path inside a collapsed directory, that directory is
 * expanded with a second scoped ls-files call.
 */
export async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<string[]> {
  let includeContent: string;
  try {
    includeContent = readFileSync(join(repoRoot, '.worktreeinclude'), 'utf-8');
  } catch {
    return []; // No .worktreeinclude file — nothing to copy
  }

  const patterns = includeContent
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));

  if (patterns.length === 0) return [];

  // Single pass with --directory: collapses fully-gitignored dirs
  // (node_modules/, .turbo/, etc.) into single entries instead of listing
  // every file inside. In a large repo this cuts ~500k entries down to
  // hundreds — the difference between ~7s and ~100ms.
  const gitignored = gitNoThrow(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    repoRoot,
  );
  if (gitignored.code !== 0 || !gitignored.stdout.trim()) {
    return [];
  }

  const entries = gitignored.stdout.trim().split('\n').filter(Boolean);

  // --directory emits collapsed dirs with a trailing slash; everything else
  // is an individual file.
  const collapsedDirs = entries.filter(e => e.endsWith('/'));
  const files = entries.filter(e => !e.endsWith('/') && matchesAnyPattern(e, patterns));

  // Edge case: a .worktreeinclude pattern targets a path inside a collapsed
  // dir (e.g. pattern `config/secrets/api.key` when all of `config/secrets/`
  // is gitignored with no tracked siblings). Expand only dirs where a pattern
  // has that dir as its explicit path prefix, a glob's literal prefix includes
  // the dir, or the dir itself matches a pattern.
  const dirsToExpand = collapsedDirs.filter(dir => {
    if (patterns.some(p => {
      const normalized = p.startsWith('/') ? p.slice(1) : p;
      // Literal prefix: pattern starts with the collapsed dir path
      if (normalized.startsWith(dir)) return true;
      // Anchored glob: dir falls under the pattern's literal (non-glob) prefix
      const globIdx = normalized.search(/[*?[]/);
      if (globIdx > 0) {
        const literalPrefix = normalized.slice(0, globIdx);
        if (dir.startsWith(literalPrefix)) return true;
      }
      return false;
    })) return true;
    // Dir stem itself matches a pattern
    if (matchesAnyPattern(dir.slice(0, -1), patterns)) return true;
    return false;
  });

  if (dirsToExpand.length > 0) {
    const expanded = gitNoThrow(
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...dirsToExpand],
      repoRoot,
    );
    if (expanded.code === 0 && expanded.stdout.trim()) {
      for (const f of expanded.stdout.trim().split('\n').filter(Boolean)) {
        if (matchesAnyPattern(f, patterns)) {
          files.push(f);
        }
      }
    }
  }

  const copied: string[] = [];

  for (const relativePath of files) {
    const srcPath = join(repoRoot, relativePath);
    const destPath = join(worktreePath, relativePath);

    try {
      await mkdir(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      copied.push(relativePath);
    } catch {
      // Best-effort — skip files that can't be copied
    }
  }

  return copied;
}

/**
 * Simple glob matching: checks if a path matches any of the given patterns.
 * Supports `*` (non-separator wildcard), `**` (any-depth glob), and `?`.
 */
function matchesAnyPattern(path: string, patterns: string[]): boolean {
  return patterns.some(p => matchGlob(path, p));
}

function matchGlob(path: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const segments = pattern.split('/');
  const regexParts: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i > 0) regexParts.push('/');

    if (seg === '**') {
      // ** matches any number of path segments
      if (i === segments.length - 1) {
        // Trailing ** matches everything
        regexParts.push('.*');
      } else {
        regexParts.push('(?:.+/)?');
      }
    } else {
      // Convert * to [^/]* and ? to [^/]
      regexParts.push(
        seg
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]'),
      );
    }
  }

  const regex = new RegExp(`^${regexParts.join('')}$`);
  return regex.test(path);
}

/**
 * Post-creation setup for a newly created worktree:
 * - Copies settings.local.json (API keys, local config)
 * - Configures git hooks from the main repository
 * - Symlinks large directories to avoid disk bloat (opt-in via options)
 * - Copies gitignored files listed in .worktreeinclude (best-effort)
 */
export async function performWorktreeSetup(
  repoRoot: string,
  worktreePath: string,
  options?: WorktreeCreateOptions,
): Promise<void> {
  copyLocalSettings(repoRoot, worktreePath);
  configureGitHooks(repoRoot, worktreePath);

  // ── Symlink directories to avoid disk bloat ──────────────────────
  const dirsToSymlink = options?.symlinkDirectories ?? [];
  if (dirsToSymlink.length > 0) {
    await symlinkLargeDirectories(repoRoot, worktreePath, dirsToSymlink);
  }

  // ── Copy .worktreeinclude files (best-effort) ────────────────────
  await copyWorktreeIncludeFiles(repoRoot, worktreePath);
}

// ---------------------------------------------------------------------------
// Agent worktree — lightweight, no global state
// ---------------------------------------------------------------------------

export interface AgentWorktree {
  worktreePath: string;
  worktreeBranch?: string;
  headCommit?: string;
  gitRoot?: string;
  /** True when the worktree was created via a WorktreeCreate hook (non-git VCS). */
  hookBased?: boolean;
}

/**
 * Create a lightweight worktree for a subagent.
 *
 * Tries WorktreeCreate hooks first (for non-git VCS support), then falls
 * back to git worktrees. When `hookManager` is not provided, hooks are
 * skipped — callers that have access to the hook manager should pass it.
 *
 * Does NOT touch global session state or call process.chdir().
 * Always resolves to the CANONICAL git root so agent worktrees
 * land in the main repo's .claude/worktrees/ — even when spawned
 * from inside a session worktree.
 */
export async function createAgentWorktree(
  slug: string,
  hookManager?: HookManager,
  options?: WorktreeCreateOptions,
): Promise<AgentWorktree> {
  validateWorktreeSlug(slug);

  // ── Try hook-based worktree creation first (user-configured VCS) ──
  const cwd = process.cwd();
  if (hookManager?.hasWorktreeCreateHook()) {
    const hookResult = await hookManager.onWorktreeCreate(
      `wt-${slug}`,
      cwd,
      slug,
    );
    if (hookResult?.worktreePath) {
      return {
        worktreePath: hookResult.worktreePath,
        hookBased: true,
      };
    }
  }

  // ── Fall back to git worktree ────────────────────────────────────
  const gitRoot = findCanonicalGitRoot(cwd);
  if (!gitRoot) {
    throw new Error(
      'Cannot create agent worktree: not in a git repository and no WorktreeCreate hooks are configured. ' +
        'Configure WorktreeCreate/WorktreeRemove hooks in settings.json to use worktree isolation with other VCS systems.',
    );
  }

  const { worktreePath, worktreeBranch, headCommit, existed } =
    await getOrCreateWorktree(gitRoot, slug, options);

  if (!existed) {
    await performWorktreeSetup(gitRoot, worktreePath, options);
  }

  // Bump mtime so stale cleanup doesn't immediately target this
  const now = new Date();
  try {
    await utimes(worktreePath, now, now);
  } catch {
    // Not fatal
  }

  return { worktreePath, worktreeBranch, headCommit, gitRoot };
}

/**
 * Remove a worktree created by createAgentWorktree.
 * For git-based worktrees, removes the worktree directory and deletes the
 * temporary branch. For hook-based worktrees, delegates to the WorktreeRemove hook.
 */
export async function removeAgentWorktree(
  worktreePath: string,
  worktreeBranch?: string,
  gitRoot?: string,
  hookBased?: boolean,
  hookManager?: HookManager,
): Promise<boolean> {
  // ── Hook-based worktree removal ──
  if (hookBased) {
    if (hookManager) {
      const hookRan = await hookManager.onWorktreeRemove(
        `wt-cleanup`,
        process.cwd(),
        worktreePath,
      );
      return hookRan;
    }
    // No hook manager available — can't clean up hook-based worktree
    return false;
  }

  // ── Git-based worktree removal ──
  return removeWorktree(worktreePath, worktreeBranch, gitRoot);
}

// ---------------------------------------------------------------------------
// Stale worktree cleanup
// ---------------------------------------------------------------------------

/**
 * Patterns for ephemeral (throwaway) worktrees created by agents and workflows.
 * These leak when the parent process is killed (Ctrl+C, kill -9) before cleanup.
 * Only slugs matching these patterns are swept — user-named worktrees are never touched.
 */
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-[a-z]+-[a-z0-9]{7,8}$/,        // agent-<type>-<shortId> (agent-spawn)
  /^agent-fork-[a-z0-9]{7,8}$/,          // agent-fork-<shortId> (fork mode)
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/,   // workflow agent (wf_<runId>-<idx>)
  // Legacy wf-<idx> slugs from before workflowRunId disambiguation — kept so
  // the sweep still cleans up worktrees leaked by older builds.
  /^wf-\d+$/,
  // Template job worktrees: job-<templateName>-<8hex>. Prefix distinguishes
  // from user-named EnterWorktree slugs that happen to end in 8 hex.
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/,
];

/**
 * Remove stale agent/workflow worktrees older than cutoffDate.
 *
 * Safety guarantees:
 * - Only touches slugs matching ephemeral patterns (never user-named worktrees)
 * - Skips the current session's worktree
 * - Fail-closed: skips if git status fails or shows tracked changes
 *   (-uno: untracked files in a stale crashed agent worktree are build
 *   artifacts; skipping the untracked scan is faster on large repos)
 * - Fail-closed: skips if any commits aren't reachable from a remote
 */
export async function cleanupStaleAgentWorktrees(
  cutoffDate: Date,
): Promise<number> {
  const gitRoot = findCanonicalGitRoot(process.cwd());
  if (!gitRoot) return 0;

  const dir = worktreesDir(gitRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const cutoffMs = cutoffDate.getTime();
  const currentPath = _currentWorktreeSession?.worktreePath;
  let removed = 0;

  for (const slug of entries) {
    // Only sweep known ephemeral patterns
    if (!EPHEMERAL_WORKTREE_PATTERNS.some(p => p.test(slug))) {
      continue;
    }

    const worktreePath = join(dir, slug);

    // Skip the currently-active session worktree
    if (currentPath === worktreePath) {
      continue;
    }

    // Check mtime — skip recently-modified worktrees
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(worktreePath)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoffMs) continue;

    // Both checks must succeed with empty output. Non-zero exit (corrupted
    // worktree, git not recognizing it, etc.) means skip — we don't know
    // what's in there. Run in parallel for efficiency.
    const [status, unpushed] = await Promise.all([
      Promise.resolve().then(() =>
        gitNoThrow(
          ['--no-optional-locks', 'status', '--porcelain', '-uno'],
          worktreePath,
        ),
      ),
      Promise.resolve().then(() =>
        gitNoThrow(
          ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes'],
          worktreePath,
        ),
      ),
    ]);

    if (status.code !== 0 || status.stdout.trim().length > 0) continue;
    if (unpushed.code !== 0 || unpushed.stdout.trim().length > 0) continue;

    if (await removeWorktree(worktreePath, worktreeBranchName(slug), gitRoot)) {
      removed++;
    }
  }

  if (removed > 0) {
    gitNoThrow(['worktree', 'prune'], gitRoot);
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Session worktree — full lifecycle with cwd isolation and state persistence
// ---------------------------------------------------------------------------

export interface WorktreeSession {
  /** The directory the user was in before entering the worktree. */
  originalCwd: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** The slug/name used to create the worktree. */
  worktreeName: string;
  /** Git branch name for the worktree (git-based only). */
  worktreeBranch?: string;
  /** The branch the user was on before entering (git-based only). */
  originalBranch?: string;
  /** SHA of HEAD when the worktree was created (for change detection). */
  originalHeadCommit?: string;
  /** Session ID associated with this worktree. */
  sessionId: string;
  /** True when the worktree was created via a WorktreeCreate hook. */
  hookBased?: boolean;
  /** How long worktree creation took (unset when resuming). */
  creationDurationMs?: number;
  /** True if git sparse-checkout was applied. */
  usedSparsePaths?: boolean;
}

let _currentWorktreeSession: WorktreeSession | null = null;

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return _currentWorktreeSession;
}

/**
 * Restore the worktree session on --resume. The caller must have already
 * verified the directory exists and set the appropriate state.
 */
export function restoreWorktreeSession(session: WorktreeSession | null): void {
  _currentWorktreeSession = session;
}

/**
 * Create or resume a worktree for the current session, then switch into it.
 *
 * This is the primary entry point for session-level worktree isolation
 * (as opposed to agent-level via createAgentWorktree). It manages the
 * full lifecycle: original cwd tracking, process.chdir, and state storage.
 *
 * When existing worktree dir already exists, it is resumed silently.
 */
export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  options?: WorktreeCreateOptions,
): Promise<WorktreeSession> {
  validateWorktreeSlug(slug);

  const originalCwd = process.cwd();

  // ── Try hook-based worktree creation first ──
  // (hooks are checked via global hook manager — consumers inject this at
  // the tool executor level; the session layer doesn't own a HookManager)
  // TODO: integrate HookManager at session level when available

  // ── Git-based worktree ──
  const gitRoot = findCanonicalGitRoot(originalCwd);
  if (!gitRoot) {
    throw new Error(
      'Cannot create session worktree: not in a git repository.',
    );
  }

  const createStart = Date.now();
  const { worktreePath, worktreeBranch, headCommit, existed } =
    await getOrCreateWorktree(gitRoot, slug, options);

  let creationDurationMs: number | undefined;
  if (!existed) {
    await performWorktreeSetup(gitRoot, worktreePath, options);
    creationDurationMs = Date.now() - createStart;
  }

  // Switch into the worktree
  process.chdir(worktreePath);

  _currentWorktreeSession = {
    originalCwd,
    worktreePath,
    worktreeName: slug,
    worktreeBranch,
    originalHeadCommit: headCommit,
    sessionId,
    creationDurationMs,
    usedSparsePaths: (options?.sparsePaths?.length ?? 0) > 0,
  };

  return _currentWorktreeSession;
}

/**
 * Preserve the worktree on session exit: switch back to the original directory
 * and clear the session state while leaving the worktree intact on disk.
 */
export function keepWorktree(): void {
  if (!_currentWorktreeSession) return;

  const { originalCwd } = _currentWorktreeSession;

  try {
    process.chdir(originalCwd);
  } catch {
    // Original cwd may no longer exist — best effort
  }

  _currentWorktreeSession = null;
}

/**
 * Remove the current session worktree.
 *
 * Switches back to the original cwd first, then removes the worktree directory
 * and associated branch. For hook-based worktrees, delegates to the hook
 * (requires HookManager). For git-based worktrees, uses git worktree remove.
 *
 * @param discardChanges If true, force removal even with uncommitted changes.
 * @param hookManager Needed for hook-based worktree removal.
 * @returns true if the worktree was successfully removed.
 */
export async function cleanupWorktree(
  discardChanges: boolean = false,
  hookManager?: HookManager,
): Promise<{
  removed: boolean;
  hasChanges?: boolean;
  error?: string;
}> {
  if (!_currentWorktreeSession) {
    return { removed: false, error: 'No active worktree session.' };
  }

  const {
    worktreePath,
    worktreeBranch,
    originalCwd,
    originalHeadCommit,
    hookBased,
  } = _currentWorktreeSession;

  // Switch back to original directory first
  try {
    process.chdir(originalCwd);
  } catch {
    // Original cwd may no longer exist
  }

  // ── Check for changes before removing ──
  if (!hookBased && originalHeadCommit && !discardChanges) {
    const changed = await hasWorktreeChanges(worktreePath, originalHeadCommit);
    if (changed) {
      _currentWorktreeSession = null; // Still clear session state
      return { removed: false, hasChanges: true };
    }
  }

  // ── Remove the worktree ──
  let removed: boolean;
  if (hookBased) {
    removed = hookManager
      ? await hookManager.onWorktreeRemove(
          _currentWorktreeSession.sessionId,
          originalCwd,
          worktreePath,
        )
      : false;
  } else {
    removed = await removeWorktree(worktreePath, worktreeBranch, originalCwd);
  }

  _currentWorktreeSession = null;

  if (!removed) {
    return {
      removed: false,
      error: `Failed to remove worktree at ${worktreePath}. You may need to remove it manually.`,
    };
  }

  return { removed: true };
}

// ── Legacy aliases for backward compatibility ──

/**
 * @deprecated Use getCurrentWorktreeSession() instead.
 */
export function getCurrentWorktree(): AgentWorktree | null {
  const s = _currentWorktreeSession;
  if (!s) return null;
  return {
    worktreePath: s.worktreePath,
    worktreeBranch: s.worktreeBranch,
    headCommit: s.originalHeadCommit,
    hookBased: s.hookBased,
  };
}

/**
 * @deprecated Session state is now managed internally by
 * createWorktreeForSession / keepWorktree / cleanupWorktree.
 */
export function setCurrentWorktree(_wt: AgentWorktree | null): void {
  // No-op — kept for backward compatibility with existing tool code
  // Session state management has moved to the functions above.
}
