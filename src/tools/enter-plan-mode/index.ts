import { schema } from './schema.js';
import { execute } from './executor.js';
import { EnterPlanModeRenderer } from './renderer.js';
import type { ToolPlugin } from '../types.js';

const enterPlanModePlugin: ToolPlugin = {
  name: 'enter-plan-mode',
  schema,
  executor: execute,
  useRenderer: EnterPlanModeRenderer,
};

export default enterPlanModePlugin;
