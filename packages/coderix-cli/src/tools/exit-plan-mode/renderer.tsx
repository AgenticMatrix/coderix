import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function ExitPlanModeRenderer(
  props: ToolUseRendererProps,
): React.ReactNode {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const planText = props.input.plan as string | undefined;
  const preview = planText
    ? planText.slice(0, 100).replace(/\n/g, ' ')
    : 'writing plan...';

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>ExitPlanMode</Text>
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    const planFile = props.result?.metadata?.planFile as string | undefined;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>ExitPlanMode</Text>
          <Text dimColor> plan approved</Text>
        </Text>
        {planFile && (
          <Box paddingLeft={3}>
            <Text dimColor>Saved to {planFile}</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Executing / pending (waiting for user approval)
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>ExitPlanMode</Text>
        <Text dimColor> {preview}</Text>
        {isExecuting ? (
          <Text dimColor color="yellow">
            {' '}
            waiting {elapsedSecs}s
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
