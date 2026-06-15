import type { ToolPlugin } from '../types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';
import { TaskCreateRenderer } from './renderer.js';
import { TaskCreateResultRenderer } from './result-renderer.js';
import { isTodoV2Enabled } from '../../tasks/store.js';

const taskCreatePlugin: ToolPlugin = {
  name: 'TaskCreate',
  schema,
  executor: execute,
  useRenderer: TaskCreateRenderer,
  resultRenderer: TaskCreateResultRenderer,
  isEnabled: () => isTodoV2Enabled(),
  paramSummary: (input) => {
    const subject = input.subject as string;
    if (!subject) return undefined;
    return subject.length > 50 ? subject.slice(0, 47) + '...' : subject;
  },
};

export default taskCreatePlugin;
