import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const updatePlugin: ToolPlugin = {
  name: 'update',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const fp = input.file_path as string;
    if (!fp) return undefined;
    return fp.split('/').slice(-2).join('/');
  },
};

export default updatePlugin;
