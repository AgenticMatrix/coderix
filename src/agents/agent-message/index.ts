import type { ToolPlugin } from '../../tools/types.js';
import { schema } from './schema.js';
import { execute } from './executor.js';
import { AgentMessageRenderer } from './renderer.js';

const agentMessagePlugin: ToolPlugin = {
  name: 'SendMessage',
  schema,
  executor: execute,
  useRenderer: AgentMessageRenderer,
};

export default agentMessagePlugin;
