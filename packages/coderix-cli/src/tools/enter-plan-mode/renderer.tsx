import React from 'react';
import { Box, Text } from '@coderix/ink';
import type { ToolUseRendererProps } from '../types.js';

export function EnterPlanModeRenderer(
  props: ToolUseRendererProps,
): React.ReactNode {
  const isDone = props.state === 'done';
  const isError = props.state === 'error';

  if (isError) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>EnterPlanMode</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    const resultContent = props.result?.content ?? '';
    const resultLines = resultContent.split('\n').filter((l) => l !== '');

    return (
      <Box flexDirection="column">
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>EnterPlanMode</Text>
        </Text>
        <Box paddingLeft={4} flexDirection="column">
          <Text dimColor>
            ⎿ planning mode active — safe tools only
            {' — '}
            {resultLines.length > 0 ? `${resultLines.length} lines` : '(empty)'}，Ctrl+D to detail
          </Text>
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
        </Box>
      </Box>
    );
  }

  // pending/executing
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="ansi:yellow">○ </Text>
        <Text bold>EnterPlanMode</Text>
        <Text dimColor> switching to plan mode...</Text>
      </Text>
    </Box>
  );
}
