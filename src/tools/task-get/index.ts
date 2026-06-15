import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';
import { TaskGetRenderer } from './renderer.js';
import { TaskGetResultRenderer } from './result-renderer.js';
import { isTodoV2Enabled } from '../../tasks/store.js';

const taskGetPlugin: ToolPlugin = {
  name: 'TaskGet',
  schema,
  executor: execute,
  useRenderer: TaskGetRenderer,
  resultRenderer: TaskGetResultRenderer,
  isEnabled: () => isTodoV2Enabled(),
  paramSummary: (input) => {
    const taskId = input.taskId as string;
    return taskId ? `#${taskId}` : undefined;
  },
};

export default taskGetPlugin;
