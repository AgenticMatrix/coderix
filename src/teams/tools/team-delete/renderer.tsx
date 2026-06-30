import React from 'react';
import { Box, Text } from 'ink';
import type { ToolUseRendererProps } from '../../../tools/types.js';

export function TeamDeleteRenderer(props: ToolUseRendererProps): React.ReactNode {
  const teamName = (props.input.name as string) ?? '?';
  const isDone = props.state === 'done';
  const indicator = isDone ? '●' : '○';
  const color = isDone ? 'green' : 'red';

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>{indicator} </Text>
        <Text bold>TeamDelete</Text>
        <Text dimColor> {teamName}</Text>
      </Text>
    </Box>
  );
}
