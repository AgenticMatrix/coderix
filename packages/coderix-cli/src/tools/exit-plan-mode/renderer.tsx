import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { Box, Text } from '@coderix/ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const SEP = '╌'.repeat(100);

function readPlanFromDisk(): string | null {
  const plansDir = join(homedir(), '.coderix', 'plans');
  try {
    const files = readdirSync(plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ path: join(plansDir, f), mtime: statSync(join(plansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files) {
      const content = readFileSync(f.path, 'utf-8').trim();
      if (content) return content;
    }
  } catch {}
  return null;
}

export function ExitPlanModeRenderer(
  props: ToolUseRendererProps,
): React.ReactNode {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting);

  const planText = props.input.plan as string | undefined;
  const preview = planText
    ? planText.slice(0, 100).replace(/\n/g, ' ')
    : 'writing plan...';

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">{'❌ '}</Text>
          <Text bold>ExitPlanMode</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    const planFile = props.result?.metadata?.planFile as string | undefined;
    const plan = props.result?.metadata?.plan as string | undefined;
    const exitChoice = (props.result?.metadata?.exitChoice
      ?? props.input._exitChoice) as string | undefined;
    const isRevision = exitChoice === 'request-changes';

    return (
      <Box flexDirection="column" marginTop={1}>
        {plan ? (
          <Box flexDirection="column" paddingLeft={1}>
            <Text dimColor>{SEP}</Text>
            <Text bold> Here is Coderix's plan:</Text>
            <Text dimColor>{SEP}</Text>
            <Text>{plan}</Text>
            <Text dimColor>{SEP}</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          {isRevision ? (
            <Box flexDirection="column">
              <Text>
                <Text color="ansi:yellow">{'● '}</Text>
                <Text bold>ExitPlanMode</Text>
                <Text dimColor> plan needs revision</Text>
              </Text>
              {planFile ? (
                <Box paddingLeft={3}>
                  <Text dimColor>{'⏿'} Plan saved to {planFile}</Text>
                </Box>
              ) : null}
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text>
                <Text color="ansi:green">{'● '}</Text>
                <Text bold>ExitPlanMode</Text>
                <Text dimColor> plan approved</Text>
              </Text>
              {planFile ? (
                <Box paddingLeft={3}>
                  <Text dimColor>{'⏿'} Saved to {planFile}</Text>
                </Box>
              ) : null}
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  // Waiting state (pending or executing): read plan directly from disk
  const diskPlan = readPlanFromDisk();

  if (diskPlan) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          <Text dimColor>{SEP}</Text>
          <Text bold> Here is Coderix's plan:</Text>
          <Text dimColor>{SEP}</Text>
          <Text>{diskPlan}</Text>
          <Text dimColor>{SEP}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>
            <Text color="ansi:yellow">{blinkOn ? '●' : '○'} </Text>
            <Text bold>ExitPlanMode</Text>
            <Text dimColor> waiting for confirmation</Text>
            {isExecuting ? (
              <Text dimColor color="ansi:yellow">{' '}{elapsedSecs}s</Text>
            ) : null}
          </Text>
        </Box>
      </Box>
    );
  }

  const indicator = isExecuting ? (blinkOn ? '●' : '○') : '○';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="ansi:yellow">{indicator} </Text>
        <Text bold>ExitPlanMode</Text>
        <Text dimColor> {preview}</Text>
        {isExecuting ? (
          <Text dimColor color="ansi:yellow">{' '}waiting {elapsedSecs}s</Text>
        ) : null}
      </Text>
    </Box>
  );
}
