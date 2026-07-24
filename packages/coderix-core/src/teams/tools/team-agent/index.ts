import type { ToolPlugin } from '../../../tools/types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const teamAgentPlugin: ToolPlugin = {
  name: 'TeamAgent',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const name = input.name as string;
    const teamName = input.team_name as string;
    if (name && teamName) return `${name}@${teamName}`;
    if (name) return name;
    return undefined;
  },
};

export default teamAgentPlugin;
