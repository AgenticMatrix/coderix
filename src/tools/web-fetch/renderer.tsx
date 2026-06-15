import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

function getUrl(input: Record<string, unknown>): string {
  return String(input.url ?? '');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function WebFetchRenderer(props: ToolUseRendererProps): React.ReactNode {
  const url = getUrl(props.input);
  const metadata = props.result?.metadata;
  const byteLength = metadata?.byteLength as number | undefined;
  const contentType = metadata?.contentType as string | undefined;
  const httpStatus = (metadata?.status ?? metadata?.httpStatus) as number | string | undefined;

  const isExecuting = props.state === 'executing';
  const isDone = props.state === 'done';
  const hasUrl = !!url;

  const isActive = isExecuting && hasUrl;
  const { elapsedSecs, blinkOn } = useToolTimer(isActive);

  const indicator = isDone ? '●' : blinkOn ? '●' : '○';
  const indicatorColor = isDone ? 'green' : 'yellow';

  const hasResult = isDone && props.result && !props.result.isError;
  const hasError = isDone && props.result?.isError;

  // Extract hostname for display
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasUrl ? (
        <>
          {/* Title line: ● WebFetch(hostname/path) */}
          <Text>
            <Text color={indicatorColor}>{indicator} </Text>
            <Text bold>WebFetch</Text>
            ({hostname.length > 50 ? hostname.slice(0, 47) + '...' : hostname})
          </Text>

          {/* Status line */}
          {isExecuting ? (
            <Text dimColor>  running {elapsedSecs}s</Text>
          ) : isDone ? (
            <Text dimColor>
              {'  '}
              {byteLength !== undefined ? formatBytes(byteLength) : ''}
              {contentType ? ` · ${contentType.split(';')[0]}` : ''}
              {httpStatus ? ` · HTTP ${httpStatus}` : ''}
              {props.duration
                ? ` · ${(props.duration / 1000).toFixed(1)}s`
                : ` · ${elapsedSecs}s`}
            </Text>
          ) : null}

          {/* Result / Error */}
          {hasResult ? (
            <Box paddingLeft={2}>
              <Text dimColor>Done</Text>
            </Box>
          ) : null}
          {hasError ? (
            <Box paddingLeft={2}>
              <Text color="red">{props.result!.content}</Text>
            </Box>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
