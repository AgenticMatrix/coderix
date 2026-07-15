import React from 'react';
import { Box, Text } from '@coderix/ink';
import type { Color } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import { detectLanguage, highlightDiffLine, groupDiffHunks } from '../shared/diffHighlight.js';
import type { ToolUseRendererProps } from '../types.js';

const HUNK_CONTEXT = 3;

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

  // Fallback: if metadata is missing, strip HTML tags from raw content
  const rawContent = props.result?.content ?? '';
  const rawPlain = rawContent.replace(/<[^>]*>/g, '');
  const rawLines = rawPlain.split('\n').filter(l => l !== '');
  const effectiveDiffLines = diffLines ?? null;
  const effectiveAdded = addedLines ?? (rawLines.length > 0 ? rawLines.length : undefined);
  const effectiveRemoved = removedLines;

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
  const indicatorColor = isError ? 'ansi:red' : isDone ? 'ansi:green' : 'ansi:yellow';

  const lang = hasPath ? detectLanguage(fp) : null;
  const diffWidth = Math.max(20, Math.floor((props.termWidth ?? 80) * 0.9) - 2);

  // Group diff into hunks around changes, with ... between non-adjacent hunks
  const hunks = effectiveDiffLines && !props.contentExpanded
    ? groupDiffHunks(effectiveDiffLines, HUNK_CONTEXT)
    : effectiveDiffLines
      ? [{ lines: effectiveDiffLines, skippedBefore: 0 }]
      : [];

  function renderDiffLine(line: string, i: number) {
    const { prefix, codeTokens, isAdd, isRemove } = highlightDiffLine(line, lang);
    const bgColor = isAdd ? 'rgb(2,40,0)' : isRemove ? 'rgb(61,1,0)' : undefined;
    const hasBackground = isAdd || isRemove;
    const dimBase = (c: Color): Color => c === '#FFFFFF' ? 'ansi:white' : c;
    return (
      <Box key={i} width={diffWidth} backgroundColor={bgColor}>
        <Text color={hasBackground ? '#FFFFFF' : 'ansi:white'}>{prefix}</Text>
        {codeTokens.map((t, j) => (
          <Text key={j} color={hasBackground ? t.color : dimBase(t.color)}>{t.text}</Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasPath ? (
        <>
          <Text>
            <Text color={indicatorColor}>{indicator} </Text>
            <Text bold>Update</Text>
            <Text dimColor>({truncatedPath})</Text>
            {isError ? (
              <Text color="ansi:red"> failed</Text>
            ) : null}
          </Text>
          {isExecuting ? (
            <Text dimColor color="ansi:yellow"> updating {elapsedSecs}s</Text>
          ) : null}
          {isDone && stats ? (
            <Box paddingLeft={2}>
              <Text dimColor>{stats}</Text>
            </Box>
          ) : null}
          {isDone && hunks.length > 0 ? (
            <Box paddingLeft={2} flexDirection="column">
              {hunks.map((hunk, hi) => (
                <React.Fragment key={hi}>
                  {hunk.skippedBefore > 0 ? (
                    <Box width={diffWidth}>
                      <Text dimColor>... {hunk.skippedBefore} unchanged lines</Text>
                    </Box>
                  ) : hi > 0 ? (
                    <Box width={diffWidth}>
                      <Text dimColor>...</Text>
                    </Box>
                  ) : null}
                  {hunk.lines.map((line, i) => renderDiffLine(line, i))}
                </React.Fragment>
              ))}
            </Box>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
