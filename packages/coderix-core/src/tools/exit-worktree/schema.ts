import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'ExitWorktree',
  description:
    `Exit the current worktree and optionally remove it. ` +
    `Use action "keep" to leave the worktree intact on disk, or "remove" to delete it. ` +
    `Set "discard_changes" to true to force removal even when there are uncommitted changes. ` +
    `When the worktree has no changes, it is automatically removed regardless of action.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description:
          '"keep" leaves the worktree directory and branch intact on disk. "remove" deletes both.',
      },
      discard_changes: {
        type: 'boolean',
        description:
          'Required true when action is "remove" and the worktree has uncommitted files or new commits. The tool will refuse and report them otherwise.',
      },
    },
    required: ['action'],
  },
  _meta: {
    riskLevel: 'destructive',
    isConcurrencySafe: false,
  },
};
