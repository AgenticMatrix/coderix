import { createElement } from 'react';
import { Box, Text } from 'ink';
import type { ToolUseRenderer } from '../../tools/types.js';

export const AgentReadRenderer: ToolUseRenderer = (props) => {
  if (props.state === 'pending') {
    return createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'grey', paddingX: 1, width: '90%' },
      createElement(Text, { dimColor: true }, `agent-read: ${props.input.list_all ? 'listing all' : `query ${props.input.agent_id ?? '?'}`}`),
    );
  }

  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'blue',
      paddingX: 1,
      width: '90%',
    },
    createElement(Text, { bold: true, color: 'cyan' }, 'agent-read'),
    props.input.list_all
      ? createElement(Text, { dimColor: true }, 'Listing all sub-agents')
      : createElement(Text, { dimColor: true }, `Querying: ${props.input.agent_id ?? '?'}`),
    props.state === 'done' && props.result && createElement(Text, {}, props.result.content.slice(0, 200)),
  );
};
