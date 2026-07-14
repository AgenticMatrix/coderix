import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

export function AskUserQuestionRenderer(
  props: ToolUseRendererProps,
): React.ReactNode {
  const questions = props.input.questions as
    | Array<{ question: string; header: string; options?: unknown[] }>
    | undefined;

  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const questionText = questions?.[0]?.question ?? 'Waiting for answer...';

  if (isError) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>AskUserQuestion</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    const answers = props.result?.metadata?.answers as
      | Record<string, string | string[]>
      | undefined;
    const firstHeader = questions?.[0]?.header ?? '';
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="ansi:green">● </Text>
          <Text bold>AskUserQuestion</Text>
          {firstHeader ? <Text bold> {firstHeader}</Text> : null}
        </Text>
        <Box paddingLeft={3} flexDirection="column">
          {questions?.map((q, i) => {
            const answer = answers?.[q.header];
            const answerStr = answer
              ? Array.isArray(answer)
                ? answer.join(', ')
                : answer
              : '(no answer)';
            return (
              <Text key={i} dimColor>
                ⎿  {q.header}: {answerStr}
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>AskUserQuestion</Text>
        <Text dimColor> {questionText.slice(0, 80)}</Text>
        {isExecuting ? (
          <Text dimColor color="ansi:yellow">
            {' '}
            waiting {elapsedSecs}s
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
