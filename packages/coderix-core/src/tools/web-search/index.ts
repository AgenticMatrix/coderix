import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const webSearchPlugin: ToolPlugin = {
  name: 'WebSearch',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const q = input.query as string;
    if (!q) return undefined;
    return q.length > 40 ? q.slice(0, 37) + '...' : q;
  },
};

export default webSearchPlugin;
