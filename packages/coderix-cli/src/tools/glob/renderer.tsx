import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function GlobRenderer(props: ToolUseRendererProps): React.ReactNode {
  const pattern = props.input.pattern as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const resultContent = props.result?.content ?? '';
  const allLines = resultContent.split('\n');
  const resultLines = allLines.filter(l => l !== '');

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>Glob</Text>
          {pattern ? <Text dimColor>({pattern})</Text> : null}
          <Text color="red"> failed</Text>
        </Text>
        {resultContent ? (
          <Box paddingLeft={3}>
            <Text color="red">{resultContent}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // Done state
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>Glob</Text>
          {pattern ? <Text dimColor>({pattern})</Text> : null}
        </Text>
        {props.contentExpanded && resultLines.length > 0 ? (
          <Box flexDirection="column">
            {resultLines.map((line, i) => (
              <Text key={i}>
                <Text dimColor>|  </Text>
                {line}
              </Text>
            ))}
          </Box>
        ) : null}
        <Text dimColor>  ⎿ Found {resultLines.length} files, consumed {props.duration ? (props.duration / 1000).toFixed(1) : elapsedSecs}s ，Ctrl+D to detail</Text>
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>Glob</Text>
        {pattern ? <Text dimColor>({pattern})</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> running {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
