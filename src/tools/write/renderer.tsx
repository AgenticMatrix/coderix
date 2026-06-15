import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const COLLAPSE_THRESHOLD = 5;

function truncatePath(fp: string): string {
  if (fp.length <= 80) return fp;
  return fp.slice(0, 40) + '...' + fp.slice(-40);
}

export function WriteRenderer(props: ToolUseRendererProps): React.ReactNode {
  const fp = (props.input.file_path as string) || '';
  const truncatedPath = fp ? truncatePath(fp) : '';
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const meta = props.result?.metadata;
  const displayPath = (meta?.filePath as string) || fp;
  const addedLines = meta?.addedLines as number | undefined;
  const removedLines = meta?.removedLines as number | undefined;
  const diffLines = meta?.diffLines as string[] | undefined;

  // Fallback: if metadata is missing, use raw result content
  const rawContent = props.result?.content ?? '';
  const rawLines = rawContent.split('\n').filter(l => l !== '');
  const effectiveDiffLines = diffLines ?? (rawLines.length > 0 ? rawLines : null);
  const effectiveAdded = addedLines ?? (effectiveDiffLines ? rawLines.length : undefined);
  const effectiveRemoved = removedLines;

  const tooLong = !props.contentExpanded && effectiveDiffLines && effectiveDiffLines.length > COLLAPSE_THRESHOLD;
  const displayDiffLines = tooLong ? effectiveDiffLines.slice(0, COLLAPSE_THRESHOLD) : effectiveDiffLines;
  const hiddenCount = effectiveDiffLines ? effectiveDiffLines.length - COLLAPSE_THRESHOLD : 0;

  // Build stats
  const parts: string[] = [];
  if (effectiveAdded !== undefined && effectiveAdded > 0) {
    parts.push(`Added ${effectiveAdded} line${effectiveAdded !== 1 ? 's' : ''}`);
  }
  if (effectiveRemoved !== undefined && effectiveRemoved > 0) {
    parts.push(`removed ${effectiveRemoved} line${effectiveRemoved !== 1 ? 's' : ''}`);
  }
  const stats = parts.length > 0 ? parts.join(', ') : undefined;

  // Error
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>Write</Text>
          {truncatedPath ? <Text dimColor>({truncatedPath})</Text> : null}
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>Write</Text>
          {truncatedPath ? <Text dimColor>({truncatedPath})</Text> : null}
        </Text>
        {stats ? (
          <Box paddingLeft={2}>
            <Text dimColor>{stats}</Text>
          </Box>
        ) : null}
        {displayDiffLines && displayDiffLines.length > 0 ? (
          <Box paddingLeft={2} flexDirection="column">
            {displayDiffLines.map((line, i) => {
              const trimmed = line.trimStart();
              const isAdd = trimmed.startsWith('+');
              const isRemove = trimmed.startsWith('-');
              if (isAdd) {
                return <Text key={i} backgroundColor="green" color="black">{line}</Text>;
              }
              if (isRemove) {
                return <Text key={i} backgroundColor="red" color="black">{line}</Text>;
              }
              return <Text key={i}>{line}</Text>;
            })}
            })}
            {tooLong ? (
              <Text dimColor>... {hiddenCount} more lines (Ctrl+D to detail)</Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>Write</Text>
        {truncatedPath ? <Text dimColor>({truncatedPath})</Text> : null}
        {isExecuting ? (
          <Text dimColor color="yellow"> writing {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
