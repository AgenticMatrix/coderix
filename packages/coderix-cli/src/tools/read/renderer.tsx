import React from 'react';
import { Box, Text } from 'ink';
import { OutputLine } from '../shared/OutputLine.js';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const MAX_DISPLAY_CHARS = 120;

function truncatePath(fp: string): string {
  if (fp.length <= MAX_DISPLAY_CHARS) return fp;
  return fp.slice(0, 60) + '...' + fp.slice(-60);
}

export function ReadRenderer(props: ToolUseRendererProps): React.ReactNode {
  const fp = (props.input.file_path as string) || '';

  const truncatedPath = fp ? truncatePath(fp) : '';

  const isExecuting = props.state === 'executing';
  const isDone = props.state === 'done';
  const hasPath = !!fp;
  const result = props.result;

  const isActive = isExecuting && hasPath;
  const { elapsedSecs, blinkOn } = useToolTimer(isActive);

  const indicator = isDone ? '●' : blinkOn ? '●' : '○';
  const indicatorColor = isDone ? 'green' : 'yellow';

  const resultLines = result?.content
    ? result.content.split('\n').filter((l) => l !== '')
    : [];
  const hasResult = isDone && result && resultLines.length > 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasPath ? (
        <>
          <Text>
            <Text color={indicatorColor}>{indicator} </Text>
            <Text bold>Read</Text>
            ({truncatedPath})
          </Text>
          {isExecuting ? (
            <Text dimColor>  Reading  {elapsedSecs}s</Text>
          ) : null}
          {isDone ? (
            <>
              {props.contentExpanded && hasResult ? (
                <Box flexDirection="column">
                  {resultLines.map((line, i) => (
                    <Text key={`out-${i}`}>
                      <Text dimColor>|  </Text>
                      <OutputLine line={line} />
                    </Text>
                  ))}
                </Box>
              ) : null}
              <Text dimColor>  ⎿ Read {resultLines.length} lines, consumed {props.duration ? (props.duration / 1000).toFixed(1) : elapsedSecs}s，Ctrl+D to detail</Text>
            </>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
