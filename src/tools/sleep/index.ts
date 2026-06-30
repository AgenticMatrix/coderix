import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const sleepPlugin: ToolPlugin = {
  name: 'Sleep',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const d = input.duration as number;
    return `${d}s`;
  },
};

export default sleepPlugin;
