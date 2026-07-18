import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const listenPlugin: ToolPlugin = {
  name: 'Listen',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const d = input.duration as number;
    return `${d}s`;
  },
};

export default listenPlugin;
