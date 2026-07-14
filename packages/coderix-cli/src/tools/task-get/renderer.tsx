import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TaskGetRenderer(props: ToolUseRendererProps): React.ReactNode {
  const taskId = props.input.taskId as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

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
          <Text color="ansi:red">❌ </Text>
          <Text bold>TaskGet</Text>
          {taskId ? <Text dimColor> · #{taskId}</Text> : null}
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
  const indicator = (isExecuting || isPending) ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>TaskGet</Text>
        {taskId ? <Text dimColor> · #{taskId}</Text> : null}
        {(isExecuting || isPending) ? (
          <Text dimColor color="ansi:yellow"> {isExecuting ? 'running' : 'pending'} {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
