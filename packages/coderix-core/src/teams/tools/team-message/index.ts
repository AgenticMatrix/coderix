import type { ToolPlugin } from '../../../tools/types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';

const sendMessagePlugin: ToolPlugin = {
  name: 'SendMessage',
  schema,
  executor: execute,
  paramSummary: (input) => {
    const hasAgentId = !!(input.agent_id as string);
    if (hasAgentId) {
      const agentId = input.agent_id as string;
      const msg = input.message as string;
      const preview = msg ? (msg.length > 20 ? msg.slice(0, 17) + '...' : msg) : '';
      return `→ ${agentId}${preview ? ': ' + preview : ''} (resume)`;
    }
    const to = input.to as string;
    const text = input.text as string;
    if (!to) return undefined;
    const preview = text ? (text.length > 20 ? text.slice(0, 17) + '...' : text) : '';
    return to === '*' ? 'broadcast' : `→ ${to}${preview ? ': ' + preview : ''}`;
  },
};

export default sendMessagePlugin;
