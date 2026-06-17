import { schema } from './schema.js';
import { execute } from './executor.js';
import { ExitPlanModeRenderer } from './renderer.js';
import type { ToolPlugin } from '../types.js';

const exitPlanModePlugin: ToolPlugin = {
  name: 'exit-plan-mode',
  schema,
  executor: execute,
  useRenderer: ExitPlanModeRenderer,
};

export default exitPlanModePlugin;
