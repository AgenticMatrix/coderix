import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const COLLAPSE_THRESHOLD = 5;

function truncatePath(fp: string): string {
  if (fp.length <= 80) return fp;
  return fp.slice(0, 40) + '...' + fp.slice(-40);
}

function getFilePath(input: Record<string, unknown>): string {
  const direct = input.file_path as string | undefined;
  if (direct) return direct;

  const partial = input._partial as string | undefined;
  if (partial) {
    // Try full JSON parse first
    try {
      const parsed = JSON.parse(partial);
      const fp = parsed.file_path as string | undefined;
      if (fp) return fp;
    } catch {
      // JSON incomplete during streaming — try regex extraction
      const m = partial.match(/"file_path"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }

  return '';
}

export function WriteRenderer(props: ToolUseRendererProps): React.ReactNode {
  const fp = getFilePath(props.input);
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
  const isNewFile = meta?.isNewFile as boolean | undefined;

  // Fallback: if metadata is missing, extract lines from raw result content
  const rawContent = props.result?.content ?? '';
  const rawLines = rawContent.split('\n').filter(l => l !== '');
  const effectiveDiffLines = diffLines ?? rawLines;
  const effectiveAdded = addedLines ?? (isNewFile !== false ? rawLines.length : undefined);
  const effectiveRemoved = removedLines;

  const tooLong = !props.contentExpanded && effectiveDiffLines && effectiveDiffLines.length > COLLAPSE_THRESHOLD;
  const displayDiffLines = tooLong ? effectiveDiffLines!.slice(0, COLLAPSE_THRESHOLD) : effectiveDiffLines;
  const hiddenCount = effectiveDiffLines ? effectiveDiffLines.length - COLLAPSE_THRESHOLD : 0;

  // Build stats line
  const statsParts: string[] = [];
  if (effectiveAdded !== undefined && effectiveAdded > 0) {
    statsParts.push(`Added ${effectiveAdded} line${effectiveAdded !== 1 ? 's' : ''}`);
  }
  if (effectiveRemoved !== undefined && effectiveRemoved > 0) {
    statsParts.push(`removed ${effectiveRemoved} line${effectiveRemoved !== 1 ? 's' : ''}`);
  }
  const stats = statsParts.length > 0 ? statsParts.join(', ') : undefined;

  // Error state
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

  // Done state — show inline diff
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
              const isAdd = line.trimStart().startsWith('+');
              const isRemove = line.trimStart().startsWith('-');
              return (
                <Text key={i} color={isAdd ? 'green' : isRemove ? 'red' : undefined}>
                  {line}
                </Text>
              );
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
