import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TaskUpdateRenderer(props: ToolUseRendererProps): React.ReactNode {
  const taskId = props.input.taskId as string | undefined;
  const statusInput = props.input.status as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  // Extract result metadata for inline display
  const newStatus = props.result?.metadata?.status as string | undefined;
  const oldStatus = props.result?.metadata?.oldStatus as string | undefined;
  const subject = (props.result?.metadata?.subject as string) ||
    (props.input.subject as string) ||
    '';

  const statusChange = oldStatus && newStatus && oldStatus !== newStatus
    ? `${oldStatus} -> ${newStatus}`
    : newStatus || statusInput || '';

  const summary = subject
    ? `Task #${taskId}: ${subject}${statusChange ? `, ${statusChange}` : ''}`
    : taskId
      ? `Task #${taskId}${statusChange ? `, ${statusChange}` : ''}`
      : '';

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>TaskUpdate</Text>
          {taskId ? <Text dimColor> · #{taskId}</Text> : null}
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state — show inline result
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>TaskUpdate</Text>
          <Text dimColor>(</Text>
          <Text>{summary}</Text>
          <Text dimColor>)</Text>
        </Text>
      </Box>
    );
  }

  // Executing state — show blinking indicator
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';
  const indicatorColor = 'yellow';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>TaskUpdate</Text>
        {taskId ? <Text dimColor> · #{taskId}</Text> : null}
        {statusInput ? <Text dimColor> → {statusInput}</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> running {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
