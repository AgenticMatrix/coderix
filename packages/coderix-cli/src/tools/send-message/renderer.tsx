import React from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
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
  const agentId = props.input.agent_id as string | undefined;
  const message = props.input.message as string | undefined;
  const teamName = props.input.team_name as string | undefined;
  const to = props.input.to as string | undefined;
  const text = props.input.text as string | undefined;
  const description = props.input.description as string | undefined;

  const isResumeMode = !!(agentId && message);
  const isTeamMode = !!(teamName);

  const hasResult = !!props.result;
  const isDone = props.state === 'done' || hasResult;
  const isExecuting = props.state === 'executing' && !hasResult;
  const isPending = props.state === 'pending' && !hasResult;
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  // ── Team messaging mode ───────────────────────────────────────────────
  if (isTeamMode && !isResumeMode) {
    const metadata = props.result?.metadata as Record<string, unknown> | undefined;
    const senderName = (metadata?.fromName as string) || (props.input.from as string) || 'leader';
    const recipientName = (metadata?.toName as string) || (to === '*' ? 'all' : (to || '?'));

    if (isError) {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color="ansi:red">❌ </Text>
            <Text bold>SendMessage</Text>
            <Text dimColor>({senderName} → {recipientName})</Text>
            <Text color="ansi:red"> failed</Text>
          </Text>
          {description ? (
            <Box marginLeft={2}>
              {renderContentLines(description)}
            </Box>
          ) : null}
        </Box>
      );
    }

    const indicator = isDone ? '●' : (blinkOn ? '●' : '○');
    const indicatorColor = isDone ? 'ansi:green' : 'ansi:yellow';
    const showTimer = (isExecuting || isPending) && !isDone;

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={indicatorColor}>{indicator} </Text>
          <Text bold>SendMessage</Text>
          <Text dimColor>({senderName} → {recipientName})</Text>
          {showTimer ? (
            <Text dimColor color="ansi:yellow"> {elapsedSecs}s</Text>
          ) : null}
        </Text>
        {text ? (
          <Box marginLeft={2}>
            {props.contentExpanded
              ? renderContentLines(text)
              : (
                <Box flexDirection="column">
                  <Text>
                    <Text dimColor>└ </Text>
                    <Text dimColor>{description || text.slice(0, 80)}</Text>
                  </Text>
                  <Text>
                    <Text dimColor>  ...Ctrl+D to detail</Text>
                  </Text>
                </Box>
              )}
          </Box>
        ) : description ? (
          <Box marginLeft={2}>
            {renderContentLines(description)}
          </Box>
        ) : null}
      </Box>
    );
  }

  // ── Sub-agent resume mode ─────────────────────────────────────────────
  const metadata = props.result?.metadata as Record<string, unknown> | undefined;
  const registry = getSubAgentRegistry();
  const agentDisplayName = (metadata?.agentName as string)
    || registry?.get(agentId!)?.name
    || agentId
    || '?';
  const headerText = `(leader → ${agentDisplayName}) · resume`;

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>SendMessage</Text>
          <Text dimColor> {headerText}</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
        {description ? (
          <Box marginLeft={2}>
            {renderContentLines(description)}
          </Box>
        ) : null}
      </Box>
    );
  }

  const indicator = isDone ? '●' : (blinkOn ? '●' : '○');
  const indicatorColor = isDone ? 'ansi:green' : 'ansi:yellow';
  const showTimer = (isExecuting || isPending) && !isDone;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>SendMessage</Text>
        <Text dimColor> {headerText}</Text>
        {showTimer ? (
          <Text dimColor color="ansi:yellow"> {elapsedSecs}s</Text>
        ) : null}
      </Text>
      {message ? (
        <Box marginLeft={2}>
          {props.contentExpanded
            ? renderContentLines(message)
            : (
              <Box flexDirection="column">
                <Text>
                  <Text dimColor>└ </Text>
                  <Text dimColor>{description || message.slice(0, 80)}</Text>
                </Text>
                <Text>
                  <Text dimColor>  ...Ctrl+D to detail</Text>
                </Text>
              </Box>
            )}
        </Box>
      ) : description ? (
        <Box marginLeft={2}>
          {renderContentLines(description)}
        </Box>
      ) : null}
    </Box>
  );
}
