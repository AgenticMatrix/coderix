import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TaskOutputRenderer(props: ToolUseRendererProps): React.ReactNode {
  const taskId = props.input.task_id as string | undefined;
  const block = (props.input.block as boolean) ?? true;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const meta = props.result?.metadata;
  const description = meta?.description as string | undefined;
  const outputLines = meta?.outputLines as string | undefined;
  const status = meta?.status as string | undefined;

  const mode = block ? 'blocking' : 'non-blocking';
  const summaryParts: string[] = [];
  if (taskId) summaryParts.push(taskId);
  summaryParts.push(mode);
  if (description) {
    const short = description.length > 50 ? description.slice(0, 47) + '...' : description;
    summaryParts.push(short);
  }
  const summary = summaryParts.join(', ');

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>TaskOutput</Text>
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
          <Text bold>TaskOutput</Text>
          <Text dimColor>(</Text>
          <Text>{summary}</Text>
          <Text dimColor>)</Text>
        </Text>
        {outputLines ? (
          <Box paddingLeft={3} flexDirection="column">
            {outputLines.split('\n').map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        ) : status ? (
          <Box paddingLeft={3}>
            <Text dimColor>{status}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // Executing / pending state — show blinking indicator for blocking mode
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>TaskOutput</Text>
        <Text dimColor>(</Text>
        <Text>{summary}</Text>
        <Text dimColor>)</Text>
        {isExecuting ? (
          <Text dimColor color="yellow"> waiting {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
