import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const ACTION_LABELS: Record<string, string> = {
  list: 'List cells',
  read: 'Read cell',
  replace: 'Replace cell',
  insert: 'Insert cell',
  delete: 'Delete cell',
};

export function NotebookEditRenderer(
  props: ToolUseRendererProps,
): React.ReactNode {
  const action = props.input.action as string | undefined;
  const path = props.input.notebook_path as string | undefined;
  const idx = props.input.cell_index as number | undefined;

  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const label = ACTION_LABELS[action ?? ''] ?? action ?? 'edit';
  const detail = idx !== undefined ? ` [${idx}]` : '';

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">{'❌'} </Text>
          <Text bold>NotebookEdit</Text>
          <Text dimColor> {label}{detail}</Text>
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    const result = props.result?.content ?? '';
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">{'●'} </Text>
          <Text bold>NotebookEdit</Text>
          <Text dimColor> {label}{detail}</Text>
        </Text>
        <Box paddingLeft={3}>
          <Text dimColor>{result.slice(0, 120)}</Text>
        </Box>
      </Box>
    );
  }

  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>NotebookEdit</Text>
        <Text dimColor> {label}{detail}</Text>
        {path ? <Text dimColor> {path.slice(-40)}</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> editing {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
