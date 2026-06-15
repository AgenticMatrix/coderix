import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';
import { TaskOutputRenderer } from './renderer.js';
import { TaskOutputResultRenderer } from './result-renderer.js';

const taskOutputPlugin: ToolPlugin = {
  name: 'TaskOutput',
  schema,
  executor: execute,
  useRenderer: TaskOutputRenderer,
  resultRenderer: TaskOutputResultRenderer,
  paramSummary: (input) => {
    const taskId = input.task_id as string;
    if (!taskId) return undefined;
    return taskId.length > 20 ? taskId.slice(0, 20) + '...' : taskId;
  },
};

export default taskOutputPlugin;
