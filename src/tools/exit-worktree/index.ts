import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const exitWorktreePlugin: ToolPlugin = {
  name: 'exit-worktree',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const action = input.action as string;
    return `action: ${action}`;
  },
};

export default exitWorktreePlugin;
