import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const PREVIEW_LINES = 5;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function WebFetchRenderer(props: ToolUseRendererProps): React.ReactNode {
  const url = props.input.url as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const meta = props.result?.metadata;
  const finalUrl = (meta?.url as string) || url || '';
  const contentType = meta?.contentType as string | undefined;
  const status = meta?.status as number | undefined;
  const byteLength = meta?.byteLength as number | undefined;

  const resultContent = props.result?.content ?? '';
  const contentLines = resultContent.split('\n');
  const bodyStart = contentLines.findIndex((l) => l === '') + 1 || 4;
  const bodyLines = contentLines.slice(bodyStart).filter((l) => l !== '');
  const tooLong = !props.contentExpanded && bodyLines.length > PREVIEW_LINES;
  const displayLines = tooLong ? bodyLines.slice(0, PREVIEW_LINES) : bodyLines;

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">✕ </Text>
          <Text bold>WebFetch</Text>
          {url ? <Text dimColor>({finalUrl || url})</Text> : null}
        </Text>
        <Box paddingLeft={2}>
          <Text dimColor>WebFetch failed</Text>
        </Box>
      </Box>
    );
  }

  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">⏺ </Text>
          <Text bold>WebFetch</Text>
          {url ? <Text dimColor>({finalUrl})</Text> : null}
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          {status !== undefined || contentType !== undefined || byteLength !== undefined ? (
            <Text dimColor>
              {status !== undefined ? `Status ${status}` : ''}
              {contentType ? ` · ${contentType}` : ''}
              {byteLength !== undefined ? ` · ${formatBytes(byteLength)}` : ''}
            </Text>
          ) : null}
          {displayLines.length > 0 ? (
            <Box flexDirection="column" marginTop={0}>
              {displayLines.map((line, i) => (
                <Text key={i} dimColor>{line.slice(0, 100)}</Text>
              ))}
              {tooLong ? (
                <Text dimColor>... {bodyLines.length - PREVIEW_LINES} more lines</Text>
              ) : null}
            </Box>
          ) : (
            <Text dimColor>(empty response)</Text>
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
        <Text bold>WebFetch</Text>
        {url ? <Text dimColor>({url})</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> fetching {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
