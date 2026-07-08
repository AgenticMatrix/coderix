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
    const resultContent = props.result?.content ?? '';
    const resultLines = resultContent.split('\n').filter((l) => l !== '');

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>EnterPlanMode</Text>
        </Text>
        <Box paddingLeft={4} flexDirection="column">
          <Text dimColor>planning mode active — safe tools only</Text>
          {props.contentExpanded && resultLines.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {resultLines.map((line, i) => (
                <Text key={i} dimColor>
                  <Text dimColor>|  </Text>
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}
          <Text dimColor>
            ⎿ {resultLines.length > 0 ? `${resultLines.length} lines` : '(empty)'}，Ctrl+D to detail
          </Text>
        </Box>
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
