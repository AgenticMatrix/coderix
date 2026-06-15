import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TodoWriteRenderer(props: ToolUseRendererProps): React.ReactNode {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const meta = props.result?.metadata;
  const count = meta?.count as number | undefined;
  const pending = meta?.pending as number | undefined;
  const inProgress = meta?.inProgress as number | undefined;
  const completed = meta?.completed as number | undefined;

  const parts: string[] = [];
  if (count !== undefined) parts.push(`${count} todos`);
  if (pending !== undefined && pending > 0) parts.push(`${pending} pending`);
  if (inProgress !== undefined && inProgress > 0) parts.push(`${inProgress} active`);
  if (completed !== undefined && completed > 0) parts.push(`${completed} completed`);
  const summary = parts.join(', ');

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>TodoWrite</Text>
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>TodoWrite</Text>
          {summary ? <Text dimColor> - {summary}</Text> : null}
        </Text>
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>TodoWrite</Text>
        {isExecuting ? (
          <Text dimColor color="yellow"> running {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
