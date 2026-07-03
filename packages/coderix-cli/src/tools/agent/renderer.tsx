import React, { useState, useEffect, useRef } from 'react';
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

const POLL_MS = 250;

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
  const isFork = !agentType;
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const label = agentType ? (AGENT_TYPE_LABEL[agentType] || agentType) : 'Fork';
  const shortDesc = description || (prompt ? (prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt) : '');
  const headerText = shortDesc ? `${label} (${shortDesc})` : label;

  const doneToolCalls: ToolCallSummary[] = (props.result?.metadata?.toolCalls as ToolCallSummary[]) ?? [];

  // Poll registry for live tool calls during execution.
  // Use a ref (always current, survives React batching) + a tick counter
  // to force re-renders so the tool tree grows progressively.
  const liveCallsRef = useRef<ToolCallSummary[]>([]);
  const [liveTick, setLiveTick] = useState(0);
  const isActive = isExecuting || isPending;

  useEffect(() => {
    if (!isActive) return;

    function poll() {
      try {
        const registry = getSubAgentRegistry();
        if (!registry) return;

        const running = registry.list().filter(a => a.status === 'running');
        if (running.length === 0) return;

        const matching = running
          .filter(a => {
            const expectedType = agentType || 'fork';
            if (expectedType === 'fork') return a.agentType === 'general-purpose';
            return a.agentType === expectedType;
          })
          .sort((a, b) => b.createdAt - a.createdAt);

        const agent = matching[0];
        if (agent?.liveToolCalls && agent.liveToolCalls.length > liveCallsRef.current.length) {
          liveCallsRef.current = [...agent.liveToolCalls];
          setLiveTick(t => t + 1);
        }
      } catch {
        // Ignore poll errors
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [isActive, agentType]);

  // Seed liveCallsRef from done result so we don't lose data on re-render
  if (isDone && doneToolCalls.length > liveCallsRef.current.length) {
    liveCallsRef.current = doneToolCalls;
  }

  const displayCalls = liveCallsRef.current.length > 0 ? liveCallsRef.current : doneToolCalls;

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

  const indicator = isDone ? '●' : (blinkOn ? '●' : '○');
  const indicatorColor = isDone ? 'green' : 'yellow';
  const statusText = isPending ? 'queued' : '';
  const showTimer = (isExecuting || isPending) && !isDone;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>{headerText}</Text>
        {showTimer ? (
          <Text dimColor color="yellow"> {statusText} {elapsedSecs}s</Text>
        ) : null}
        {background && !isFork ? <Text dimColor> (background)</Text> : null}
        {isolation ? <Text dimColor> isolated: {isolation}</Text> : null}
        {isDone ? <Text dimColor> · {props.duration ? `${(props.duration / 1000).toFixed(1)}s` : ''}</Text> : null}
      </Text>
      {displayCalls.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {displayCalls.map((tc, i) => {
            const isLast = i === displayCalls.length - 1;
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
