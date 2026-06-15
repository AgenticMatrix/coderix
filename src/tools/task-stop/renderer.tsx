import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TaskStopRenderer(props: ToolUseRendererProps): React.ReactNode {
  const taskId = props.input.task_id as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const meta = props.result?.metadata;
  const description = meta?.description as string | undefined;
  const taskType = meta?.taskType as string | undefined;

  const summaryParts: string[] = [];
  if (taskId) summaryParts.push(taskId);
  if (description) {
    const short = description.length > 50 ? description.slice(0, 47) + '...' : description;
    summaryParts.push(short);
  }
  const summary = summaryParts.join(': ');

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>TaskStop</Text>
          {taskId ? <Text dimColor> · {taskId}</Text> : null}
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
          <Text bold>TaskStop</Text>
          <Text dimColor>(</Text>
          <Text>{summary}</Text>
          <Text dimColor>)</Text>
          <Text dimColor> · stopped</Text>
        </Text>
      </Box>
    );
  }

  // Executing / pending state
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>TaskStop</Text>
        {taskId ? <Text dimColor> · {taskId}</Text> : null}
        {taskType ? <Text dimColor> ({taskType})</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> stopping {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
