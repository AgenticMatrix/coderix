import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const webFetchPlugin: ToolPlugin = {
  name: 'WebFetch',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const url = input.url as string;
    if (!url) return undefined;
    try { const u = new URL(url); return u.hostname; } catch { return url.slice(0, 40); }
  },
};

export default webFetchPlugin;
