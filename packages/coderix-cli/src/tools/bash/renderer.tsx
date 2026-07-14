import React from 'react';
import { Box, Text } from '@coderix/ink';
import { OutputLine } from '../shared/OutputLine.js';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const MAX_DISPLAY_CHARS = 60;
const COLLAPSE_THRESHOLD = 1;
const PER_LINE_CHAR_LIMIT = 100;

function extractCommentLabel(command: string): string | null {
  const lines = command.split('\n');
  let best: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
      const label = trimmed.replace(/^#+\s*/, '');
      if (!best || label.length > best.length) {
        best = label;
      }
    }
  }
  return best;
}

function getCommand(input: Record<string, unknown>): string {
  const direct = input.command as string | undefined;
  if (direct) return direct;

  const partial = input._partial as string | undefined;
  if (partial) {
    try {
      const parsed = JSON.parse(partial);
      return (parsed.command as string) ?? '';
    } catch {
      return '';
    }
  }

  return '';
}

export function BashRenderer(props: ToolUseRendererProps): React.ReactNode {
  const command = getCommand(props.input);
  const description =
    (props.input.description as string) ||
    (command ? extractCommentLabel(command) : null);

  const truncate = (s: string) =>
    s.length > MAX_DISPLAY_CHARS ? s.slice(0, MAX_DISPLAY_CHARS).trim() + '…' : s;
  const truncatedCmd = command ? truncate(command) : '';
  const truncatedDesc = description ? truncate(description) : null;

  const isExecuting = props.state === 'executing';
  const isDone = props.state === 'done';
  const hasCommand = !!command;
  const result = props.result;

  const isActive = isExecuting && hasCommand;
  const { elapsedSecs, blinkOn } = useToolTimer(isActive);

  const indicator = isDone ? '●' : blinkOn ? '●' : '○';
  const indicatorColor = isDone ? 'ansi:green' : 'ansi:yellow';

  const indent = ' '.repeat(4);

  const displayCmd = ((): string => {
    if (truncatedDesc) return truncatedCmd.split('\n').map(l => indent + l).join('\n');
    const lines = truncatedCmd.split('\n');
    return lines.length > 2
      ? lines.slice(0, 2).join('\n') + '…'
      : truncatedCmd;
  })();

  // ── Inline result display ──────────────────────────────────────
  const resultContent = result?.content ?? '';
  const resultMetadata = result?.metadata;
  const stderr = resultMetadata?.stderr as string | undefined;
  const exitCode = resultMetadata?.exitCode as number | null | undefined;
  const timedOut = resultMetadata?.timedOut as boolean | undefined;

  const stdoutLines = resultContent ? resultContent.split('\n').filter(l => l !== '') : [];
  const stderrLines = stderr ? stderr.split('\n').filter(l => l !== '') : [];
  const emptiness = stdoutLines.length === 0 && stderrLines.length === 0;

  const displayOutLines = props.contentExpanded
    ? stdoutLines
    : stdoutLines
        .slice(0, COLLAPSE_THRESHOLD)
        .map(l => l.length > PER_LINE_CHAR_LIMIT ? l.slice(0, PER_LINE_CHAR_LIMIT) + '…' : l);
  const hiddenCount = props.contentExpanded ? 0 : stdoutLines.length - COLLAPSE_THRESHOLD;

  const hasResult = isDone && result;

  // Always return JSX to avoid null→JSX transition that may cause remount.
  // Render an empty placeholder until command is available.
  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasCommand ? (
        <>
          <Text>
            <Text color={indicatorColor}>{indicator} </Text>
            <Text bold>Bash</Text>
            ({truncatedDesc ? `${truncatedDesc},\n${displayCmd}` : displayCmd})
          </Text>
          {isExecuting ? (
            <Text dimColor>    running  {elapsedSecs}s</Text>
          ) : null}

          {/* Inline result content */}
          {hasResult ? (
            <Box flexDirection="column" paddingLeft={4}>
              {timedOut ? (
                <Text color="ansi:red">Command timed out</Text>
              ) : null}
              {emptiness ? (
                <Text color={result.isError ? 'ansi:red' : 'ansi:green'} dimColor>
                  {result.isError ? '(error — no output)' : 'Done'}
                </Text>
              ) : null}
              {displayOutLines.map((line, i) =>
                line.trimStart().startsWith('Error:') ? (
                  <Text key={`out-${i}`} color="ansi:red">{line}</Text>
                ) : (
                  <Text key={`out-${i}`} dimColor>
                    <OutputLine line={line} />
                  </Text>
                )
              )}
              {stderrLines.length > 0 ? (
                <Box flexDirection="column" marginTop={stdoutLines.length > 0 ? 1 : 0}>
                  {stderrLines.map((line, i) =>
                    result.isError ? (
                      <Text key={`err-${i}`} color="ansi:red">{line}</Text>
                    ) : (
                      <OutputLine key={`err-${i}`} line={line} isStderr />
                    )
                  )}
                </Box>
              ) : null}
              {result.isError && exitCode != null ? (
                <Box marginTop={(stdoutLines.length > 0 || stderrLines.length > 0) ? 1 : 0}>
                  <Text color="ansi:red">Exit code: {exitCode}</Text>
                </Box>
              ) : null}
              {!emptiness ? (
                hiddenCount > 0 ? (
                  <Text dimColor>... {hiddenCount} more lines, Execution consumed {props.duration ? (props.duration / 1000).toFixed(1) : elapsedSecs}s，Ctrl+D to detail</Text>
                ) : (
                  <Text dimColor>Execution consumed {props.duration ? (props.duration / 1000).toFixed(1) : elapsedSecs}s</Text>
                )
              ) : null}
            </Box>
          ) : isDone ? (
            <Text dimColor>    Execution consumed {props.duration ? (props.duration / 1000).toFixed(1) : elapsedSecs}s</Text>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
