import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const COLLAPSE_THRESHOLD = 5;

export function GrepRenderer(props: ToolUseRendererProps): React.ReactNode {
  const pattern = props.input.pattern as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const resultContent = props.result?.content ?? '';
  const allLines = resultContent.split('\n');
  const resultLines = allLines.filter(l => l !== '');
  const tooLong = !props.contentExpanded && resultLines.length > COLLAPSE_THRESHOLD;
  const displayLines = tooLong ? resultLines.slice(0, COLLAPSE_THRESHOLD) : resultLines;
  const hiddenCount = resultLines.length - COLLAPSE_THRESHOLD;

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>Grep</Text>
          {pattern ? <Text dimColor>({pattern})</Text> : null}
          <Text color="red"> failed</Text>
        </Text>
        {resultContent ? (
          <Box paddingLeft={3}>
            <Text color="red">{resultContent}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // Done state — always show result content below
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>Grep</Text>
          {pattern ? <Text dimColor>({pattern})</Text> : null}
        </Text>
        <Box paddingLeft={3} flexDirection="column">
          {resultLines.length > 0 ? (
            <>
              {displayLines.map((line, i) => (
                <Text key={i}>{line}</Text>
              ))}
              {tooLong ? (
                <Text dimColor>... {hiddenCount} more lines (Ctrl+D to detail)</Text>
              ) : null}
            </>
          ) : (
            <Text dimColor>(no matches)</Text>
          )}
        </Box>
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>Grep</Text>
        {pattern ? <Text dimColor>({pattern})</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> running {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
