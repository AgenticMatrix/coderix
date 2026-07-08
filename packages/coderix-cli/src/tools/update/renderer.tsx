import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import { detectLanguage, highlightDiffLine } from '../shared/diffHighlight.js';
import type { ToolUseRendererProps } from '../types.js';

const COLLAPSE_THRESHOLD = 5;

function truncatePath(fp: string): string {
  if (fp.length <= 80) return fp;
  return fp.slice(0, 40) + '...' + fp.slice(-40);
}

export function UpdateRenderer(props: ToolUseRendererProps): React.ReactNode {
  const fp = (props.input.file_path as string) || '';
  const truncatedPath = fp ? truncatePath(fp) : '';
  const hasPath = !!fp;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const isActive = isExecuting && hasPath;
  const { elapsedSecs, blinkOn } = useToolTimer(isActive);

  const meta = props.result?.metadata;
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

  const indicator = isError ? '❌' : isDone ? '●' : blinkOn ? '●' : '○';
  const indicatorColor = isError ? 'red' : isDone ? 'green' : 'yellow';

  const lang = hasPath ? detectLanguage(fp) : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasPath ? (
        <>
          <Text>
            <Text color={indicatorColor}>{indicator} </Text>
            <Text bold>Update</Text>
            <Text dimColor>({truncatedPath})</Text>
            {isError ? (
              <Text color="red"> failed</Text>
            ) : null}
          </Text>
          {isExecuting ? (
            <Text dimColor color="yellow"> updating {elapsedSecs}s</Text>
          ) : null}
          {isDone && stats ? (
            <Box paddingLeft={2}>
              <Text dimColor>{stats}</Text>
            </Box>
          ) : null}
          {isDone && displayDiffLines && displayDiffLines.length > 0 ? (
            <Box paddingLeft={2} flexDirection="column">
              {displayDiffLines.map((line, i) => {
                const { prefix, codeTokens, isAdd, isRemove } = highlightDiffLine(line, lang);
                const bgColor = isAdd ? 'rgb(2,40,0)' : isRemove ? 'rgb(61,1,0)' : undefined;
                const hasBackground = isAdd || isRemove;
                // Context lines: dim base color to terminal 'white' (gray-white),
                // but keep highlight colors (magenta, green, etc.) as-is.
                const dimBase = (c: string) => c === '#FFFFFF' ? 'white' : c;
                return (
                  <Box key={i} width="90%" backgroundColor={bgColor}>
                    <Text color={hasBackground ? '#FFFFFF' : 'white'}>{prefix}</Text>
                    {codeTokens.map((t, j) => (
                      <Text key={j} color={hasBackground ? t.color : dimBase(t.color)}>{t.text}</Text>
                    ))}
                  </Box>
                );
              })}
              {tooLong ? (
                <Box width="90%">
                  <Text dimColor>... {hiddenCount} more lines (Ctrl+D to detail)</Text>
                </Box>
              ) : null}
            </Box>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
