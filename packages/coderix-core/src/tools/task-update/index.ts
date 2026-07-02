import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';
import { isTodoV2Enabled } from '../../tasks/store.js';

const taskUpdatePlugin: ToolPlugin = {
  name: 'TaskUpdate',
  schema,
  executor: execute,
  isEnabled: () => isTodoV2Enabled(),
  paramSummary: (input) => {
    const taskId = input.taskId as string;
    const status = input.status as string;
    return taskId ? `#${taskId}${status ? ` → ${status}` : ''}` : undefined;
  },
};

export default taskUpdatePlugin;
