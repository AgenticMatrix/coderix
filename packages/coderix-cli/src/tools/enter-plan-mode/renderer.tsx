import React from 'react';
import { Box, Text } from 'ink';
import type { ToolUseRendererProps } from '../types.js';

export function EnterPlanModeRenderer(
  props: ToolUseRendererProps,
): React.ReactNode {
  const isDone = props.state === 'done';
  const isError = props.state === 'error';

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>EnterPlanMode</Text>
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>EnterPlanMode</Text>
          <Text dimColor> planning mode active — safe tools only</Text>
        </Text>
      </Box>
    );
  }

  // pending/executing
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">○ </Text>
        <Text bold>EnterPlanMode</Text>
        <Text dimColor> switching to plan mode...</Text>
      </Text>
    </Box>
  );
}
