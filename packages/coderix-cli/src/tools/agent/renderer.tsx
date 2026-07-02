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

export function AgentRenderer(props: ToolUseRendererProps): React.ReactNode {
  const agentType = props.input.agent_type as string | undefined;
  const prompt = props.input.prompt as string | undefined;
  const background = (props.input.background as boolean) ?? false;
  const isolation = props.input.isolation as string | undefined;
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const label = agentType ? (AGENT_TYPE_LABEL[agentType] || agentType) : 'Fork';
  const shortPrompt = prompt
    ? prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt
    : '';

  // Error state
  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="red">❌ </Text>
          <Text bold>Agent · {label}</Text>
          <Text color="red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Done state
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>Agent · {label}</Text>
          {shortPrompt ? <Text dimColor> · {shortPrompt}</Text> : null}
          {background ? <Text color="green"> (background)</Text> : null}
        </Text>
      </Box>
    );
  }

  // Executing / pending state
  const indicator = (isExecuting || isPending) ? (blinkOn ? '●' : '○') : '○';
  const statusText = isExecuting ? '' : 'queued';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>Agent · {label}</Text>
        {shortPrompt ? <Text dimColor> · {shortPrompt}</Text> : null}
        {(isExecuting || isPending) ? (
          <Text dimColor color="yellow"> {statusText} {elapsedSecs}s</Text>
        ) : null}
        {background ? <Text dimColor> (background)</Text> : null}
        {isolation ? <Text dimColor> isolated: {isolation}</Text> : null}
      </Text>
    </Box>
  );
}
