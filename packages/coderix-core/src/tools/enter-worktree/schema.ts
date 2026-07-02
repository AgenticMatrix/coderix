import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'EnterWorktree',
  description:
    `Creates or enters a git worktree — an isolated working directory that shares the same git history. ` +
    `Use this when you need to work in isolation from the main working directory. ` +
    `Pass "name" to create a new worktree, or "path" to enter an existing one. ` +
    `Each "/"-separated segment of the name may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. ` +
    `GitHub PR references ("#123" or "https://github.com/owner/repo/pull/123") are automatically detected and create a PR-based worktree.`,
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Name for the new worktree. Creates a new isolated worktree under .claude/worktrees/. Mutually exclusive with "path".',
      },
      path: {
        type: 'string',
        description:
          'Path to an existing worktree to enter. Must appear in "git worktree list". Mutually exclusive with "name".',
      },
    },
  },
  _meta: {
    riskLevel: 'mutation',
    isConcurrencySafe: false,
  },
};
