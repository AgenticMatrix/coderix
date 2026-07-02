import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const enterWorktreePlugin: ToolPlugin = {
  name: 'enter-worktree',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const name = input.name as string | undefined;
    const path = input.path as string | undefined;
    if (name) return `name: ${name}`;
    if (path) return `path: ${path}`;
    return undefined;
  },
};

export default enterWorktreePlugin;
