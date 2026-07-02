import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';
import { isTodoV2Enabled } from '../../tasks/store.js';

const taskGetPlugin: ToolPlugin = {
  name: 'TaskGet',
  schema,
  executor: execute,
  isEnabled: () => isTodoV2Enabled(),
  paramSummary: (input) => {
    const taskId = input.taskId as string;
    return taskId ? `#${taskId}` : undefined;
  },
};

export default taskGetPlugin;
