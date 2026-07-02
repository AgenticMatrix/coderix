import { schema } from './schema.js';
import { execute } from './executor.js';
import type { ToolPlugin } from '../types.js';

const enterPlanModePlugin: ToolPlugin = {
  name: 'EnterPlanMode',
  schema,
  executor: execute,
};

export default enterPlanModePlugin;
