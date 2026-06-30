import type { ToolPlugin } from '../../../tools/types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';
import { TeamDeleteRenderer } from './renderer.js';

const teamDeletePlugin: ToolPlugin = {
  name: 'TeamDelete',
  schema,
  executor: execute,
  useRenderer: TeamDeleteRenderer,
  paramSummary: (input) => {
    const name = input.name as string;
    return name ? `Delete: ${name}` : undefined;
  },
};

export default teamDeletePlugin;
