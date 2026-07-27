import React from 'react';
import { Box, Text } from '@coderix/ink';
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
          <Text color="ansi:red">❌ </Text>
          <Text bold>ExitPlanMode</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    const planFile = props.result?.metadata?.planFile as string | undefined;
    const plan = props.result?.metadata?.plan as string | undefined;
    const SEP = '╌'.repeat(100);

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="ansi:green">{'● '}</Text>
          <Text bold>ExitPlanMode</Text>
          <Text dimColor> plan approved</Text>
        </Text>
        {planFile ? (
          <Box paddingLeft={3}>
            <Text dimColor>{'⏿'} Saved to {planFile}</Text>
          </Box>
        ) : null}
        {plan ? (
          <Box flexDirection="column" marginTop={1} paddingLeft={1}>
            <Text dimColor>{SEP}</Text>
            <Text bold> Here is Coderix's plan:</Text>
            <Text dimColor>{SEP}</Text>
            <Text>{plan}</Text>
            <Text dimColor>{SEP}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // Executing / pending (waiting for user confirmation)
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';
  const inputPlan = props.input._planContent as string | undefined;
  const SEP = '╌'.repeat(100);

  // Show plan content even while waiting for confirmation
  if (isExecuting && inputPlan) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text dimColor>{SEP}</Text>
          <Text bold> Here is Coderix's plan:</Text>
          <Text dimColor>{SEP}</Text>
          <Text>{inputPlan}</Text>
          <Text dimColor>{SEP}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>
            <Text color="ansi:yellow">{blinkOn ? '●' : '○'} </Text>
            <Text bold>ExitPlanMode</Text>
            <Text dimColor> waiting for confirmation</Text>
            <Text dimColor color="ansi:yellow">
              {' '}
              {elapsedSecs}s
            </Text>
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>ExitPlanMode</Text>
        <Text dimColor> {preview}</Text>
        {isExecuting ? (
          <Text dimColor color="ansi:yellow">
            {' '}
            waiting {elapsedSecs}s
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
