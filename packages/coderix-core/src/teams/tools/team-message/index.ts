import type { ToolPlugin } from '../../../tools/types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const sendMessagePlugin: ToolPlugin = {
  name: 'SendMessage',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const agentName = input.agent_name as string;
    const text = input.text as string;
    if (!agentName) return undefined;
    const preview = text ? (text.length > 20 ? text.slice(0, 17) + '...' : text) : '';
    if (agentName === '*') return 'broadcast';
    if (agentName === 'leader') return `→ leader${preview ? ': ' + preview : ''}`;
    return `→ ${agentName}${preview ? ': ' + preview : ''}`;
  },
};

export default sendMessagePlugin;
