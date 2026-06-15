import { Box, Text } from 'ink';
import { BaseToolRenderer } from '../base/BaseToolRenderer.js';
import type { ToolUseRendererProps } from '../types.js';
import type { SearchResult } from './search-service.js';

export function WebSearchRenderer(props: ToolUseRendererProps) {
  const results = props.result?.metadata?.searchResults as SearchResult[] | undefined;

  return (
    <BaseToolRenderer {...props}>
      {results && results.length > 0 ? (
        <Box flexDirection="column">
          {results.slice(0, 3).map((r, i) => (
            <Box key={i} flexDirection="column" marginBottom={0}>
              <Text>
                <Text bold>{i + 1}. </Text>
                <Text>{r.title}</Text>
              </Text>
              <Text dimColor>   {r.url}</Text>
            </Box>
          ))}
          {results.length > 3 ? (
            <Text dimColor>   ... and {results.length - 3} more results</Text>
          ) : null}
        </Box>
      ) : null}
    </BaseToolRenderer>
  );
}
