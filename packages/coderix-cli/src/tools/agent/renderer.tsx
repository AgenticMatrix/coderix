import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { getSubAgentRegistry } from '@coderix/core';
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

const POLL_MS = 300;

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

  const doneToolCalls: ToolCallSummary[] = (props.result?.metadata?.toolCalls as ToolCallSummary[]) ?? [];

  // Poll registry for live tool calls during execution
  const [liveToolCalls, setLiveToolCalls] = useState<ToolCallSummary[]>([]);
  const isActive = isExecuting || isPending;

  useEffect(() => {
    if (!isActive) return;

    function poll() {
      try {
        const registry = getSubAgentRegistry();
        if (!registry) return;

        const running = registry.list().filter(a => a.status === 'running');
        if (running.length === 0) return;

        // Match the most recently started agent of the same type
        const matching = running
          .filter(a => {
            const expectedType = agentType || 'fork';
            if (expectedType === 'fork') return a.agentType === 'general-purpose';
            return a.agentType === expectedType;
          })
          .sort((a, b) => b.createdAt - a.createdAt);

        const agent = matching[0];
        if (agent?.liveToolCalls && agent.liveToolCalls.length > 0) {
          setLiveToolCalls([...agent.liveToolCalls]);
        }
      } catch {
        // Ignore poll errors
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [isActive, agentType]);

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

  // Done state — use final toolCalls from result metadata
  if (isDone) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="green">● </Text>
          <Text bold>{headerText}</Text>
          {background ? <Text color="green"> (background)</Text> : null}
        </Text>
        {doneToolCalls.length > 0 && (
          <Box flexDirection="column" marginLeft={2}>
            {doneToolCalls.map((tc, i) => {
              const isLast = i === doneToolCalls.length - 1;
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

  // Executing / pending state — show live tool calls from registry
  const indicator = blinkOn ? '●' : '○';
  const statusText = isExecuting ? '' : 'queued';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="yellow">{indicator} </Text>
        <Text bold>{headerText}</Text>
        {isExecuting || isPending ? (
          <Text dimColor color="yellow"> {statusText} {elapsedSecs}s</Text>
        ) : null}
        {background ? <Text dimColor> (background)</Text> : null}
        {isolation ? <Text dimColor> isolated: {isolation}</Text> : null}
      </Text>
      {liveToolCalls.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {liveToolCalls.map((tc, i) => {
            const isLast = i === liveToolCalls.length - 1;
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
