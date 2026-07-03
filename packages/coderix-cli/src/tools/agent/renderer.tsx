import React from 'react';
import { Box, Text } from 'ink';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const AGENT_TYPE_LABEL: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  'general-purpose': 'General Purpose',
  fork: 'Fork',
};

interface ToolCallSummary {
  name: string;
  input: string;
  state: string;
}

export function AgentRenderer(props: ToolUseRendererProps): React.ReactNode {
  const agentType = props.input.agent_type as string | undefined;
  const description = props.input.description as string | undefined;
  const prompt = props.input.prompt as string | undefined;
  const background = (props.input.background as boolean) ?? false;
  const isolation = props.input.isolation as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const label = agentType ? (AGENT_TYPE_LABEL[agentType] || agentType) : 'Fork';
  const shortDesc = description || (prompt ? (prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt) : '');
  const headerText = shortDesc ? `${label} (${shortDesc})` : label;

  const toolCalls: ToolCallSummary[] = (props.result?.metadata?.toolCalls as ToolCallSummary[]) ?? [];

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>{headerText}</Text>
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>{headerText}</Text>
          {background ? <Text color="green"> (background)</Text> : null}
        </Text>
        {toolCalls.length > 0 && (
          <Box flexDirection="column" marginLeft={2}>
            {toolCalls.map((tc, i) => {
              const isLast = i === toolCalls.length - 1;
              const prefix = isLast ? '└── ' : '├── ';
              return (
                <Text key={i} dimColor>
                  {prefix}{tc.name} · {tc.input}
                </Text>
              );
            })}
          </Box>
        )}
      </Box>
    );
  }

  const indicator = (isExecuting || isPending) ? (blinkOn ? '●' : '○') : '○';
  const statusText = isExecuting ? '' : 'queued';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>{headerText}</Text>
        {(isExecuting || isPending) ? (
          <Text dimColor color="yellow"> {statusText} {elapsedSecs}s</Text>
        ) : null}
        {background ? <Text dimColor> (background)</Text> : null}
        {isolation ? <Text dimColor> isolated: {isolation}</Text> : null}
      </Text>
    </Box>
  );
}
