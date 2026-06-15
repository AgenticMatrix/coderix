import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TaskGetRenderer(props: ToolUseRendererProps): React.ReactNode {
  const taskId = props.input.taskId as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const meta = props.result?.metadata;
  const subject = meta?.subject as string | undefined;
  const status = meta?.status as string | undefined;
  const description = meta?.description as string | undefined;
  const activeForm = meta?.activeForm as string | undefined;
  const owner = meta?.owner as string | undefined;
  const blocks = meta?.blocks as string[] | undefined;
  const blockedBy = meta?.blockedBy as string[] | undefined;

  const summary = subject
    ? `Task #${taskId}: ${subject}`
    : taskId
      ? `Task #${taskId}`
      : '';

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>TaskGet</Text>
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
          <Text bold>TaskGet</Text>
          <Text dimColor>(</Text>
          <Text>{summary}</Text>
          <Text dimColor>)</Text>
        </Text>
        {status && (
          <Box paddingLeft={3} flexDirection="column">
            <Text>Status: <Text bold>{status}</Text></Text>
            {description && <Text>Description: {description}</Text>}
            {activeForm && <Text dimColor>Active form: {activeForm}</Text>}
            {owner && <Text dimColor>Owner: {owner}</Text>}
            {blocks && blocks.length > 0 && (
              <Text dimColor>Blocks: {blocks.join(', ')}</Text>
            )}
            {blockedBy && blockedBy.length > 0 && (
              <Text dimColor>Blocked by: {blockedBy.join(', ')}</Text>
            )}
          </Box>
        )}
      </Box>
    );
  }

  // Executing / pending state
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>TaskGet</Text>
        {taskId ? <Text dimColor> · #{taskId}</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> running {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
