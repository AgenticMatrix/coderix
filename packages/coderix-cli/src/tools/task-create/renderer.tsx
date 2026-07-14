import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TaskCreateRenderer(props: ToolUseRendererProps): React.ReactNode {
  const subject = props.input.subject as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  // Extract result metadata for inline display
  const taskId = props.result?.metadata?.taskId as string | undefined;
  const createdSubject = (props.result?.metadata?.subject as string) || subject || '';
  const summary = taskId
    ? `Task #${taskId}: ${createdSubject}`
    : subject || '';

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>TaskCreate</Text>
          {subject ? <Text dimColor> · {subject}</Text> : null}
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state — show inline result
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>TaskCreate</Text>
          <Text dimColor>(</Text>
          <Text>{summary}</Text>
          <Text dimColor>)</Text>
        </Text>
      </Box>
    );
  }

  // Executing state — show blinking indicator
  const indicator = (isExecuting || isPending) ? (blinkOn ? '●' : '○') : '○';
  const indicatorColor = 'ansi:yellow';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>TaskCreate</Text>
        {subject ? <Text dimColor> · {subject}</Text> : null}
        {(isExecuting || isPending) ? (
          <Text dimColor color="ansi:yellow"> {isExecuting ? 'running' : 'pending'} {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
