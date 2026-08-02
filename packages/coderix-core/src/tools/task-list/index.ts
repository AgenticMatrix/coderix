import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const taskListPlugin: ToolPlugin = {
  name: 'TaskList',
  schema,
  executor: execute,
  paramSummary: () => undefined,
};

export default taskListPlugin;
