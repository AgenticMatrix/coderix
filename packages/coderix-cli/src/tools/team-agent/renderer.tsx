import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
import type { ToolUseRendererProps } from '../types.js';

const POLL_MS = 250;

export function TeamAgentRenderer(props: ToolUseRendererProps): React.ReactNode {
  const teamName = props.input.team_name as string | undefined;
  const workerName = props.input.name as string | undefined;
  const description = props.input.description as string | undefined;
  const prompt = props.input.prompt as string | undefined;
  const hasResult = !!props.result;
  const isDone = props.state === 'done' || hasResult;
  const isExecuting = props.state === 'executing' && !hasResult;
  const isPending = props.state === 'pending' && !hasResult;
  const isError = props.state === 'error';

  const shortDesc = description || (prompt ? (prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt) : '');
  const headerText = workerName && teamName
    ? `${workerName}@${teamName}`
    : (shortDesc ? `TeamAgent (${shortDesc})` : 'TeamAgent');

  // Derive elapsed time from the agent's createdAt registry timestamp
  const createdAtRef = useRef<number>(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  const elapsedSecs = createdAtRef.current > 0
    ? ((now - createdAtRef.current) / 1000).toFixed(1)
    : '0.0';
  const blinkOn = Math.floor(now / 500) % 2 === 0;

  const workerAgentId = props.result?.metadata?.agentId as string | undefined;

  // Poll registry for the worker's status
  const [liveTick, setLiveTick] = useState(0);
  const [bgRunning, setBgRunning] = useState(true);
  const isActive = isExecuting || isPending || (isDone && bgRunning);

  useEffect(() => {
    if (!isActive) return;

    function poll() {
      try {
        const registry = getSubAgentRegistry();
        if (!registry) return;

        const running = registry.list().filter(a => a.status === 'running');
        const matching = running.filter(a => props.toolId ? a.toolUseId === props.toolId : false);

        const agent = matching[0];
        if (!agent) {
          if (isDone) setBgRunning(false);
          return;
        }

        if (agent.createdAt) {
          createdAtRef.current = agent.createdAt;
        }

        setLiveTick(t => t + 1);
      } catch {
        // Ignore poll errors
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [isActive]);

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">X </Text>
          <Text bold>{headerText}</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  const trulyDone = isDone && !bgRunning;
  const indicator = trulyDone ? '●' : (blinkOn ? '●' : '○');
  const indicatorColor = trulyDone ? 'ansi:green' : 'ansi:yellow';
  const showTimer = !trulyDone;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>{headerText}</Text>
        {showTimer ? (
          <Text dimColor color="ansi:yellow"> {elapsedSecs}s</Text>
        ) : null}
        {trulyDone ? <Text dimColor> {props.duration ? `${(props.duration / 1000).toFixed(1)}s` : ''}</Text> : null}
      </Text>
      {trulyDone && workerAgentId ? (
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>worker({workerAgentId}) completed</Text>
        </Box>
      ) : null}
    </Box>
  );
}
