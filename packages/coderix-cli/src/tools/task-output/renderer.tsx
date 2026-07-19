import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TaskOutputRenderer(props: ToolUseRendererProps): React.ReactNode {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const meta = props.result?.metadata;
  const displayId = (meta?.taskId as string) || (props.input.task_id as string);
  const description =
    (meta?.description as string) || (props.input.command as string);
  const outputLines = meta?.outputLines as string | undefined;

  const summaryParts: string[] = [];
  if (displayId) summaryParts.push(displayId);
  if (description) {
    summaryParts.push(
      description.length > 50 ? description.slice(0, 47) + '...' : description,
    );
  }
  const summary = summaryParts.join(', ');

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>TaskOutput</Text>
          {displayId ? (
            <>
              <Text dimColor>(</Text>
              <Text>{summary}</Text>
              <Text dimColor>)</Text>
            </>
          ) : null}
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>TaskOutput</Text>
          <Text dimColor>(</Text>
          <Text>{summary}</Text>
          <Text dimColor>)</Text>
        </Text>
        <Box paddingLeft={2}>
          <Text dimColor>└ completed</Text>
        </Box>
        {outputLines ? (
          <Box paddingLeft={4} flexDirection="column">
            {outputLines.split('\n').map((line, i) => (
              <Text key={i} dimColor>
                ⎿ {line}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  }

  // Executing / Pending
  const indicator = blinkOn ? '●' : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>TaskOutput</Text>
        <Text dimColor>(</Text>
        <Text>{summary}</Text>
        <Text dimColor>)</Text>
        <Text dimColor color="ansi:yellow">
          {' '}
          {isExecuting ? 'waiting' : 'pending'} {elapsedSecs}s
        </Text>
      </Text>
    </Box>
  );
}
