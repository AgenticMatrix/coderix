import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function GrepRenderer(props: ToolUseRendererProps): React.ReactNode {
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
          <Text color="ansi:red">❌ </Text>
          <Text bold>Grep</Text>
          {pattern ? <Text dimColor>({pattern})</Text> : null}
          <Text color="ansi:red"> failed</Text>
        </Text>
        {resultContent ? (
          <Box paddingLeft={3}>
            <Text color="ansi:red">{resultContent}</Text>
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
          <Text color="ansi:green">● </Text>
          <Text bold>Grep</Text>
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
        <Text dimColor>  ⎿ Found {resultLines.length} matches, consumed {props.duration ? (props.duration / 1000).toFixed(1) : elapsedSecs}s ，Ctrl+O to detail</Text>
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>Grep</Text>
        {pattern ? <Text dimColor>({pattern})</Text> : null}
        {isExecuting ? (
          <Text dimColor color="ansi:yellow"> running {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
