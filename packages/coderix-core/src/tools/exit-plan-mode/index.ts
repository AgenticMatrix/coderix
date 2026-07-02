import { schema } from './schema.js';
import { execute } from './executor.js';
import type { ToolPlugin } from '../types.js';

const exitPlanModePlugin: ToolPlugin = {
  name: 'exit-plan-mode',
  schema,
  executor: execute,
};

export default exitPlanModePlugin;
