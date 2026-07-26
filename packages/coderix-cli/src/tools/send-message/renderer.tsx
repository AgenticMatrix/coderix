import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const WRAP_WIDTH = 80;

function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > maxWidth) {
      let breakAt = maxWidth;
      const spaceIdx = remaining.lastIndexOf(' ', maxWidth);
      if (spaceIdx > maxWidth / 2) {
        breakAt = spaceIdx;
      }
      lines.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    if (remaining.length > 0) {
      lines.push(remaining);
    }
  }
  return lines;
}

function renderContentLines(text: string): React.ReactNode {
  return wrapText(text, WRAP_WIDTH).map((line, i) => (
    <Text key={i}>
      <Text dimColor>{i === 0 ? '└ ' : '  '}</Text>
      <Text dimColor>{line}</Text>
    </Text>
  ));
}

export function SendMessageRenderer(props: ToolUseRendererProps): React.ReactNode {
  const agentName = (props.input.agent_name as string) || '?';
  const teamName = (props.input.team_name as string) || '?';
  const text = (props.input.text as string) || '';
  const description = (props.input.description as string) || '';

  const metadata = props.result?.metadata as Record<string, unknown> | undefined;
  const senderName = (metadata?.fromName as string) || (props.input.from as string) || 'leader';

  const hasResult = !!props.result;
  const isDone = props.state === 'done' || hasResult;
  const isExecuting = props.state === 'executing' && !hasResult;
  const isPending = props.state === 'pending' && !hasResult;
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const recipientLabel = agentName === '*' ? 'all' : agentName;

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>SendMessage</Text>
          <Text dimColor> ({teamName}/{senderName} → {recipientLabel}{description ? `: ${description}` : ''})</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  const indicator = isDone ? '●' : (blinkOn ? '●' : '○');
  const indicatorColor = isDone ? 'ansi:green' : 'ansi:yellow';
  const showTimer = (isExecuting || isPending) && !isDone;

  const displayText = text;
  const wrappedLines = wrapText(displayText, WRAP_WIDTH);
  const firstLine = wrappedLines[0] || '';
  const moreCount = wrappedLines.length - 1;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>SendMessage</Text>
        <Text dimColor> ({teamName}/{senderName} → {recipientLabel}{description ? `: ${description}` : ''})</Text>
        {showTimer ? (
          <Text dimColor color="ansi:yellow"> {elapsedSecs}s</Text>
        ) : null}
      </Text>
      {displayText ? (
        <Box marginLeft={2}>
          {props.contentExpanded
            ? renderContentLines(displayText)
            : (
              <Box flexDirection="column">
                <Text>
                  <Text dimColor>└ </Text>
                  <Text dimColor>{firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine}</Text>
                </Text>
                {moreCount > 0 && (
                  <Text>
                    <Text dimColor>  ... {moreCount} more line{moreCount > 1 ? 's' : ''}, Ctrl+O to detail</Text>
                  </Text>
                )}
              </Box>
            )}
        </Box>
      ) : null}
    </Box>
  );
}
