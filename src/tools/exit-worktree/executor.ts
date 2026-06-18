import type { ToolExecutor } from '../types.js';
import {
  getCurrentWorktreeSession,
  keepWorktree,
  cleanupWorktree,
} from '../../utils/worktree.js';

export const execute: ToolExecutor = async (input, _options) => {
  const action = input.action as 'keep' | 'remove';
  const discardChanges = (input.discard_changes as boolean) ?? false;

  const session = getCurrentWorktreeSession();
  if (!session) {
    return {
      content:
        'Not currently in a worktree session. Use enter-worktree to start one.',
      isError: false,
    };
  }

  const { worktreePath, worktreeBranch } = session;

  // ── keep action ─────────────────────────────────────────────────────
  if (action === 'keep') {
    keepWorktree();
    return {
      content:
        `Worktree preserved at: ${worktreePath}` +
        (worktreeBranch ? ` (branch: ${worktreeBranch})` : '') +
        `\nSwitched back to original directory. You can resume the worktree by running: cd ${worktreePath}`,
      isError: false,
      metadata: { worktreePath, kept: true },
    };
  }

  // ── remove action ───────────────────────────────────────────────────
  if (action === 'remove') {
    const result = await cleanupWorktree(discardChanges);

    if (result.hasChanges) {
      return {
        content:
          `Worktree at ${worktreePath} has uncommitted changes or new commits.\n` +
          `To force removal and discard these changes, re-run with discard_changes: true.\n` +
          `To keep the worktree, use action: "keep" instead.`,
        isError: true,
        metadata: { worktreePath, hasChanges: true },
      };
    }

    if (result.removed) {
      return {
        content: `Removed worktree at: ${worktreePath}` +
          (worktreeBranch ? ` (branch: ${worktreeBranch} deleted)` : ''),
        isError: false,
        metadata: { worktreePath, removed: true },
      };
    }

    return {
      content:
        (result.error ?? `Failed to remove worktree at ${worktreePath}.`) +
        `\nYou can try removing it manually: rm -rf ${worktreePath}`,
      isError: true,
      metadata: { worktreePath, removed: false },
    };
  }

  return {
    content: `Unknown action: ${action}. Use "keep" or "remove".`,
    isError: true,
  };
};
