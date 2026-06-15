import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';
import { WriteRenderer } from './renderer.js';
import { WriteResultRenderer } from './result-renderer.js';

const writePlugin: ToolPlugin = {
  name: 'write',
  schema,
  executor: execute,
  useRenderer: WriteRenderer,
  resultRenderer: WriteResultRenderer,
  paramSummary: (input) => {
    const fp = input.file_path as string;
    if (!fp) return undefined;
    return fp.split('/').slice(-2).join('/');
  },
};

export default writePlugin;
