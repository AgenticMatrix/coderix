import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

interface TaskSummary {
  id: string;
  subject: string;
  status: string;
  owner?: string;
}

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '⟳',
  completed: '✓',
};

export function TaskListRenderer(props: ToolUseRendererProps): React.ReactNode {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const tasks = (props.result?.metadata?.tasks as TaskSummary[]) || [];
  const count = isDone ? `${tasks.length} task(s)` : '';

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>TaskList</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state — show tasks inline
  if (isDone && tasks.length > 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>TaskList</Text>
          <Text dimColor> · {count}</Text>
        </Text>
        {tasks.map((t) => (
          <Box key={t.id} paddingLeft={3}>
            <Text dimColor>
              {STATUS_ICON[t.status] || '○'} #{t.id} {t.subject}
              {t.owner ? ` (${t.owner})` : ''}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  // Done but empty
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>TaskList</Text>
          <Text dimColor> · empty</Text>
        </Text>
      </Box>
    );
  }

  // Executing / pending state
  const indicator = (isExecuting || isPending) ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>TaskList</Text>
        {(isExecuting || isPending) ? (
          <Text dimColor color="ansi:yellow"> {isExecuting ? 'running' : 'pending'} {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
