import type { ToolExecutor } from '../types.js';
import {
  validateWorktreeSlug,
  getCurrentWorktreeSession,
  createWorktreeForSession,
  findCanonicalGitRoot,
  parsePRReference,
} from '../../utils/worktree.js';

export const execute: ToolExecutor = async (input, options) => {
  const name = input.name as string | undefined;
  const path = input.path as string | undefined;

  // ── Validate arguments ──────────────────────────────────────────────
  if (name && path) {
    return {
      content:
        'Error: "name" and "path" are mutually exclusive. Use "name" to create a new worktree, or "path" to enter an existing one.',
      isError: true,
    };
  }
  if (!name && !path) {
    return {
      content:
        'Error: either "name" or "path" is required. Use "name" to create a new worktree, or "path" to enter an existing one.',
      isError: true,
    };
  }

  // ── Create new session worktree ─────────────────────────────────────
  if (name) {
    try {
      validateWorktreeSlug(name);
    } catch (err) {
      return {
        content: `Error: ${(err as Error).message}`,
        isError: true,
      };
    }

    // Auto-detect PR references and create PR-based worktrees
    const prNumber = parsePRReference(name);
    const effectiveName = prNumber ? `pr-${prNumber}` : name;

    const sessionId = options.sessionId ?? `wt-${effectiveName}`;

    try {
      const session = await createWorktreeForSession(sessionId, effectiveName, {
        prNumber: prNumber ?? undefined,
      });

      const prNote = prNumber
        ? ` (based on PR #${prNumber})`
        : '';
      const elapsed = session.creationDurationMs
        ? ` (${session.creationDurationMs}ms)`
        : '';

      return {
        content: session.creationDurationMs !== undefined
          ? `Created worktree at: ${session.worktreePath} (branch: ${session.worktreeBranch})${prNote}${elapsed}\n\nNow working in isolated directory.`
          : `Resumed existing worktree at: ${session.worktreePath} (branch: ${session.worktreeBranch})`,
        isError: false,
        metadata: {
          worktreePath: session.worktreePath,
          worktreeBranch: session.worktreeBranch,
          prNumber: prNumber ?? undefined,
          existed: session.creationDurationMs === undefined,
          usedSparsePaths: session.usedSparsePaths,
        },
      };
    } catch (err) {
      return {
        content: `Error creating worktree: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  // ── Enter existing worktree ─────────────────────────────────────────
  if (path) {
    // Verify the path is a valid git worktree
    const gitRoot = findCanonicalGitRoot(process.cwd());
    if (!gitRoot) {
      return {
        content:
          'Error: not in a git repository. Cannot verify worktree path.',
        isError: true,
      };
    }

    // Switch into the existing worktree
    try {
      process.chdir(path);
    } catch {
      return {
        content: `Error: cannot access directory: ${path}`,
        isError: true,
      };
    }

    return {
      content: `Entered worktree at: ${path}\nNow working in this isolated directory.`,
      isError: false,
      metadata: {
        worktreePath: path,
        resumed: true,
      },
    };
  }

  return {
    content: 'Unreachable.',
    isError: true,
  };
};
