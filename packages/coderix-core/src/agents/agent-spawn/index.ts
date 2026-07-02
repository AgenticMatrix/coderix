import type { ToolPlugin } from '../../tools/types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const agentSpawnPlugin: ToolPlugin = {
  name: 'Agent',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const prompt = input.prompt as string;
    if (!prompt) return undefined;
    return prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt;
  },
};

export default agentSpawnPlugin;
