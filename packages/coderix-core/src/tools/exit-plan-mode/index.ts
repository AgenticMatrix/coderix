import { schema } from './schema.js';
import { execute } from './executor.js';
import type { ToolPlugin } from '../types.js';

const exitPlanModePlugin: ToolPlugin = {
  name: 'ExitPlanMode',
  schema,
  executor: execute,
};

export default exitPlanModePlugin;
