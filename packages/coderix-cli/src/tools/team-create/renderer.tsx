import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TeamCreateRenderer(props: ToolUseRendererProps): React.ReactNode {
  const description = props.input.description as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const teamName = (props.result?.metadata?.teamName as string) || '';
  const headerSummary = description || '';

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>TeamCreate</Text>
          {headerSummary ? <Text dimColor>({headerSummary})</Text> : null}
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state — show inline result
  if (isDone) {
    const resultLines = props.result?.content
      ? props.result.content.split('\n')
      : [];

    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>TeamCreate</Text>
          {headerSummary ? <Text dimColor>({headerSummary})</Text> : null}
        </Text>
        {props.contentExpanded ? (
          <Box flexDirection="column" marginLeft={2}>
            <Text dimColor>⎿ {teamName} created.</Text>
            {resultLines.slice(1).map((line, i) => (
              <Text key={`detail-${i}`} dimColor>
                {line ? `   ${line}` : ''}
              </Text>
            ))}
          </Box>
        ) : (
          <Text dimColor>  ⎿ {teamName} created  ...Ctrl+D to detail</Text>
        )}
      </Box>
    );
  }

  // Executing/Pending state — show blinking indicator
  const indicator = (isExecuting || isPending) ? (blinkOn ? '●' : '○') : '○';
  const indicatorColor = 'ansi:yellow';

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>TeamCreate</Text>
        {headerSummary ? <Text dimColor>({headerSummary})</Text> : null}
        {(isExecuting || isPending) ? (
          <Text dimColor color="ansi:yellow"> {isExecuting ? 'running' : 'pending'} {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
