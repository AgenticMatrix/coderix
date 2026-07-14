import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

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
  const bodyLines = resultContent.split('\n').filter((l) => l !== '');

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">✕ </Text>
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
    const parts: string[] = [];
    if (status !== undefined) parts.push(`Status ${status}`);
    if (contentType) parts.push(contentType);
    if (bodyLines.length > 0) parts.push(`${bodyLines.length} lines`);
    else parts.push('(empty)');
    if (byteLength !== undefined) parts.push(formatBytes(byteLength));

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:green">⏺ </Text>
          <Text bold>WebFetch</Text>
          {url ? <Text dimColor>({finalUrl})</Text> : null}
        </Text>
        {props.contentExpanded && bodyLines.length > 0 ? (
          <Box flexDirection="column">
            {bodyLines.map((line, i) => (
              <Text key={i} dimColor>
                <Text dimColor>|  </Text>
                {line.slice(0, 100)}
              </Text>
            ))}
          </Box>
        ) : null}
        <Text dimColor>  ⎿ {parts.join(' · ')}，Ctrl+D to detail</Text>
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>WebFetch</Text>
        {url ? <Text dimColor>({url})</Text> : null}
        {isExecuting ? (
          <Text dimColor color="ansi:yellow"> fetching {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
