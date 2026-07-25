import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function TeamDeleteRenderer(props: ToolUseRendererProps): React.ReactNode {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const teamName = (props.result?.metadata?.teamName as string) || '';

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>TeamDelete</Text>
          {teamName ? <Text dimColor> {teamName}</Text> : null}
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state
  if (isDone) {
    const resultLines = props.result?.content
      ? props.result.content.split('\n')
      : [];
    const firstLine = resultLines[0] || `Team '${teamName}' deleted.`;
    const extraLines = resultLines.length - 1;

    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>TeamDelete</Text>
        </Text>
        {props.contentExpanded ? (
          <Box flexDirection="column" marginLeft={2}>
            <Text dimColor>⎿ {firstLine}</Text>
            {resultLines.slice(1).map((line, i) => (
              <Text key={`detail-${i}`} dimColor>
                {line ? `   ${line}` : ''}
              </Text>
            ))}
          </Box>
        ) : (
          <Box marginLeft={2}>
            <Text dimColor>
              ⎿ {firstLine}
              {extraLines > 0 ? '  ...Ctrl+O to detail' : ''}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // Executing/Pending state
  const indicator = (isExecuting || isPending) ? (blinkOn ? '●' : '○') : '○';
  const indicatorColor = 'ansi:yellow';

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>TeamDelete</Text>
        {teamName ? <Text dimColor> {teamName}</Text> : null}
        {(isExecuting || isPending) ? (
          <Text dimColor color="ansi:yellow"> {isExecuting ? 'running' : 'pending'} {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
