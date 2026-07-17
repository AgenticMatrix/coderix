import type { ToolPlugin } from '../../../tools/types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const teamCreatePlugin: ToolPlugin = {
  name: 'TeamCreate',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const name = input.team_name as string;
    return name ? `Team: ${name}` : undefined;
  },
};

export default teamCreatePlugin;
