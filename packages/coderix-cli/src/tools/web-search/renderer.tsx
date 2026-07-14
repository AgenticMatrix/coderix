import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';
import type { SearchResult } from '@coderix/core';

export function WebSearchRenderer(props: ToolUseRendererProps): React.ReactNode {
  const query = props.input.query as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const results = props.result?.metadata?.searchResults as SearchResult[] | undefined;
  const resultCount = (props.result?.metadata?.resultCount as number) ?? results?.length ?? 0;

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">✕ </Text>
          <Text bold>WebSearch</Text>
          {query ? <Text>(&quot;{query}&quot;)</Text> : null}
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>WebSearch</Text>
          {query ? <Text>(&quot;{query}&quot;)</Text> : null}
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>⎿  Found {resultCount} result{resultCount !== 1 ? 's' : ''} for &quot;{query || ''}&quot;</Text>
        </Box>
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>WebSearch</Text>
        {query ? <Text dimColor>(&quot;{query}&quot;)</Text> : null}
        {isExecuting ? (
          <Text dimColor color="ansi:yellow"> searching {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
