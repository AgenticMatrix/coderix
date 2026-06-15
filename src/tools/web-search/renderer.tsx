import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';
import type { SearchResult } from './search-service.js';

const MAX_VISIBLE = 3;

export function WebSearchRenderer(props: ToolUseRendererProps): React.ReactNode {
  const query = props.input.query as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const results = props.result?.metadata?.searchResults as SearchResult[] | undefined;
  const resultCount = (props.result?.metadata?.resultCount as number) ?? results?.length ?? 0;
  const visibleResults = results?.slice(0, MAX_VISIBLE) ?? [];
  const hiddenCount = results ? results.length - MAX_VISIBLE : 0;

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>WebSearch</Text>
          {query ? <Text dimColor>(&quot;{query}&quot;)</Text> : null}
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state — show results inline
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>WebSearch</Text>
          <Text dimColor>(&quot;{query || ''}&quot;)</Text>
        </Text>
        {visibleResults.length > 0 ? (
          <Box paddingLeft={3} flexDirection="column">
            {visibleResults.map((r, i) => (
              <Box key={i} flexDirection="column" marginBottom={0}>
                <Text>
                  <Text bold>{i + 1}. </Text>
                  <Text>{r.title}</Text>
                </Text>
                <Text dimColor>   {r.url}</Text>
              </Box>
            ))}
            {hiddenCount > 0 ? (
              <Text dimColor>   ... and {hiddenCount} more results</Text>
            ) : null}
            <Text dimColor>--- {resultCount} results ---</Text>
          </Box>
        ) : (
          <Box paddingLeft={3}>
            <Text dimColor>(no results)</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>WebSearch</Text>
        {query ? <Text dimColor>(&quot;{query}&quot;)</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> searching {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
