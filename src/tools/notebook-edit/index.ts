import { schema } from './schema.js';
import { execute } from './executor.js';
import { NotebookEditRenderer } from './renderer.js';
import type { ToolPlugin } from '../types.js';

const notebookEditPlugin: ToolPlugin = {
  name: 'notebook-edit',
  schema,
  executor: execute,
  useRenderer: NotebookEditRenderer,
  paramSummary(input: Record<string, unknown>) {
    const action = input.action as string;
    const idx = input.cell_index as number | undefined;
    const detail = idx !== undefined ? ` [${idx}]` : '';
    return `${action}${detail}`;
  },
};

export default notebookEditPlugin;
