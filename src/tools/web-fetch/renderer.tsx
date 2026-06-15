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

function shortenUrl(url: string): string {
  if (url.length <= 60) return url;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.slice(0, 40)}...`;
  } catch {
    return url.slice(0, 57) + '...';
  }
}

export function WebFetchRenderer(props: ToolUseRendererProps): React.ReactNode {
  const url = props.input.url as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const meta = props.result?.metadata;
  const finalUrl = meta?.url as string | undefined;
  const contentType = meta?.contentType as string | undefined;
  const status = meta?.status as number | undefined;
  const byteLength = meta?.byteLength as number | undefined;
  const displayUrl = finalUrl || url || '';

  const resultContent = props.result?.content ?? '';
  const contentLines = resultContent.split('\n');
  // Skip header lines (first 4-5 lines are metadata)
  const bodyStart = contentLines.findIndex((l) => l === '') + 1 || 4;
  const bodyLines = contentLines.slice(bodyStart).filter((l) => l !== '');
  const tooLong = !props.contentExpanded && bodyLines.length > PREVIEW_LINES;
  const displayLines = tooLong ? bodyLines.slice(0, PREVIEW_LINES) : bodyLines;

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>WebFetch</Text>
          {url ? <Text dimColor>"{shortenUrl(url)}"</Text> : null}
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state — show result inline
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>WebFetch</Text>
          <Text dimColor>("{shortenUrl(displayUrl)}")</Text>
        </Text>
        <Box paddingLeft={3} flexDirection="column">
          <Text dimColor>{displayUrl}</Text>
          <Text>
            {status !== undefined ? (
              <>
                <Text dimColor>Status: </Text>
                <Text color={status >= 200 && status < 300 ? 'green' : 'yellow'}>{status}</Text>
              </>
            ) : null}
            {contentType ? (
              <>
                <Text dimColor> · Type: </Text>
                <Text>{contentType}</Text>
              </>
            ) : null}
            {byteLength !== undefined ? (
              <>
                <Text dimColor> · Size: </Text>
                <Text>{formatBytes(byteLength)}</Text>
              </>
            ) : null}
          </Text>
          {bodyLines.length > 0 ? (
            <Box flexDirection="column" marginTop={0}>
              {displayLines.map((line, i) => (
                <Text key={i} dimColor>{line.slice(0, 100)}</Text>
              ))}
              {tooLong ? (
                <Text dimColor>... {bodyLines.length - PREVIEW_LINES} more lines (Ctrl+D to detail)</Text>
              ) : null}
            </Box>
          ) : null}
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
        {url ? <Text dimColor>("{shortenUrl(url)}")</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> fetching {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
