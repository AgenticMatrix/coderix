import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TaskOutputRenderer(props: ToolUseRendererProps): React.ReactNode {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const meta = props.result?.metadata;
  const displayId = (meta?.taskId as string) || (props.input.task_id as string);
  const description =
    (meta?.description as string) || (props.input.command as string);
  const outputLines = meta?.outputLines as string | undefined;
  const taskStatus = meta?.status as string | undefined;

  const summaryParts: string[] = [];
  if (displayId) summaryParts.push(displayId);
  if (description) {
    summaryParts.push(
      description.length > 50 ? description.slice(0, 47) + '...' : description,
    );
  }
  const summary = summaryParts.join(', ');

  // Done state
  if (isDone) {
    const lines = outputLines ? outputLines.split('\n').filter(l => l !== '') : [];
    const displayLines = props.contentExpanded ? lines : lines.slice(0, 1);
    const hiddenCount = props.contentExpanded ? 0 : lines.length - 1;
    const isTaskError = taskStatus === 'error';
    const isTimeout = taskStatus === 'timeout';

    // TaskOutput itself failed (e.g. invalid task_id) — metadata has no status
    if (props.result?.isError && !taskStatus) {
      return (
        <Box flexDirection="column" marginBottom={0}>
          <Text>
            <Text color="ansi:green">● </Text>
            <Text bold>TaskOutput</Text>
            <Text dimColor>(</Text>
            <Text>{summary}</Text>
            <Text dimColor>)</Text>
          </Text>
          <Box paddingLeft={2}>
            <Text dimColor>└ failed</Text>
          </Box>
        </Box>
      );
    }

    let statusLabel: string;
    if (isTaskError) statusLabel = 'Task Error';
    else if (isTimeout) statusLabel = 'Task not completed';
    else statusLabel = 'Task completed successfully';

    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>TaskOutput</Text>
          <Text dimColor>(</Text>
          <Text>{summary}</Text>
          <Text dimColor>)</Text>
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          {lines.length === 0 ? (
            isTaskError ? (
              <Text color="ansi:red">
                └ {statusLabel} (error)
              </Text>
            ) : (
              <Text dimColor>
                └ {statusLabel} (no output)
              </Text>
            )
          ) : (
            <>
              {isTaskError ? (
                <Text color="ansi:red">
                  └ {statusLabel}: {displayLines[0]}
                </Text>
              ) : (
                <Text dimColor>
                  └ {statusLabel}: {displayLines[0]}
                </Text>
              )}
              {displayLines.slice(1).map((line, i) => (
                <Text key={i} dimColor>  {line}</Text>
              ))}
            </>
          )}
          {hiddenCount > 0 ? (
            <Text dimColor>  ... {hiddenCount} more lines, Ctrl+O to detail</Text>
          ) : null}
        </Box>
      </Box>
    );
  }

  // Executing / Pending
  const indicator = blinkOn ? '●' : '○';

  return (
    <Box flexDirection="column" marginBottom={0}>
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
