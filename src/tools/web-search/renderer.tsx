import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';
import type { SearchResult } from './search-service.js';

const MAX_VISIBLE_RESULTS = 3;

function getQuery(input: Record<string, unknown>): string {
  return String(input.query ?? '');
}

export function WebSearchRenderer(props: ToolUseRendererProps): React.ReactNode {
  const query = getQuery(props.input);
  const results = props.result?.metadata?.searchResults as SearchResult[] | undefined;
  const resultCount =
    (props.result?.metadata?.resultCount as number) ?? results?.length ?? 0;

  const isExecuting = props.state === 'executing';
  const isDone = props.state === 'done';
  const hasQuery = !!query;

  const isActive = isExecuting && hasQuery;
  const { elapsedSecs, blinkOn } = useToolTimer(isActive);

  const indicator = isDone ? '●' : blinkOn ? '●' : '○';
  const indicatorColor = isDone ? 'green' : 'yellow';

  const hasResult = isDone && results && results.length > 0;
  const isEmpty = isDone && resultCount === 0;

  const visibleResults = hasResult ? results!.slice(0, MAX_VISIBLE_RESULTS) : [];
  const hiddenCount = hasResult ? results!.length - MAX_VISIBLE_RESULTS : 0;

  const displayQuery =
    query.length > 50 ? query.slice(0, 47) + '...' : query;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasQuery ? (
        <>
          {/* Title line: ● WebSearch("query") */}
          <Text>
            <Text color={indicatorColor}>{indicator} </Text>
            <Text bold>WebSearch</Text>
            ({displayQuery})
          </Text>

          {/* Status line */}
          {isExecuting ? (
            <Text dimColor>  running {elapsedSecs}s</Text>
          ) : isDone ? (
            <Text dimColor>
              {'  '}
              {resultCount > 0
                ? `${resultCount} result${resultCount !== 1 ? 's' : ''}`
                : 'No results'}
              {props.duration
                ? ` · ${(props.duration / 1000).toFixed(1)}s`
                : ` · ${elapsedSecs}s`}
            </Text>
          ) : null}

          {/* Result body */}
          {hasResult ? (
            <Box flexDirection="column" paddingLeft={2}>
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
            </Box>
          ) : null}

          {/* Empty state */}
          {isEmpty ? (
            <Box paddingLeft={2}>
              <Text dimColor>(no results found)</Text>
            </Box>
          ) : null}

          {/* Error state */}
          {isDone && props.result?.isError ? (
            <Box paddingLeft={2}>
              <Text color="red">{props.result.content}</Text>
            </Box>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
