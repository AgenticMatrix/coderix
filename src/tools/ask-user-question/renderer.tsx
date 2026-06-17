import React from 'react';
import { Box, Text } from 'ink';
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
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>AskUserQuestion</Text>
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    const answers = props.result?.metadata?.answers as
      | Record<string, string | string[]>
      | undefined;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>AskUserQuestion</Text>
          {questions?.map((q, i) => (
            <Text key={i} dimColor>
              {' '}
              {q.header}:{' '}
              {answers?.[q.header]
                ? Array.isArray(answers[q.header])
                  ? (answers[q.header] as string[]).join(', ')
                  : answers[q.header]
                : '(no answer)'}
            </Text>
          ))}
        </Text>
      </Box>
    );
  }

  // Executing / pending
  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>AskUserQuestion</Text>
        <Text dimColor> {questionText.slice(0, 80)}</Text>
        {isExecuting ? (
          <Text dimColor color="yellow">
            {' '}
            waiting {elapsedSecs}s
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
