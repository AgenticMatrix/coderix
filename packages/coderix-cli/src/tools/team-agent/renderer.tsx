import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
import type { ToolUseRendererProps } from '../types.js';

const AGENT_TYPE_LABEL: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  'general-purpose': 'General Purpose',
  worker: 'Worker',
};

const TOOL_LABEL: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  write: 'Write',
  update: 'Update',
  'WebSearch': 'WebSearch',
  'WebFetch': 'WebFetch',
  task: 'Task',
  SendMessage: 'SendMsg',
};

const TOOL_KEY_PARAM: Record<string, string> = {
  bash: 'command',
  read: 'file_path',
  grep: 'pattern',
  glob: 'pattern',
  write: 'file_path',
  update: 'file_path',
  edit: 'file_path',
  'WebSearch': 'query',
  'WebFetch': 'url',
  SendMessage: 'text',
};

function formatToolCallDetail(tc: ToolCallSummary): string {
  let inputObj: Record<string, unknown> | null = null;
  try {
    inputObj = JSON.parse(tc.input);
  } catch {
    return tc.input;
  }

  const desc = inputObj?.description as string | undefined;
  const keyParam = TOOL_KEY_PARAM[tc.name];
  const keyValue = keyParam ? (inputObj?.[keyParam] as string | undefined) : undefined;

  const parts: string[] = [];
  if (desc) parts.push(desc);
  if (keyValue) {
    parts.push(keyValue.length > 90 ? keyValue.slice(0, 87) + '...' : keyValue);
  } else if (!desc) {
    const str = tc.input.length > 100 ? tc.input.slice(0, 97) + '...' : tc.input;
    parts.push(str);
  }

  return parts.join(', ');
}

function toolLabel(name: string): string {
  return TOOL_LABEL[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

interface ToolCallSummary {
  name: string;
  input: string;
  state: string;
}

const POLL_MS = 250;

export function TeamAgentRenderer(props: ToolUseRendererProps): React.ReactNode {
  const name = props.input.name as string | undefined;
  const teamName = props.input.team_name as string | undefined;
  const description = props.input.description as string | undefined;
  const agentType = props.input.agent_type as string | undefined;
  const prompt = props.input.prompt as string | undefined;
  const isolation = props.input.isolation as string | undefined;
  const hasResult = !!props.result;
  const isDone = props.state === 'done' || hasResult;
  const isExecuting = props.state === 'executing' && !hasResult;
  const isPending = props.state === 'pending' && !hasResult;
  const isError = props.state === 'error';

  const label = agentType ? (AGENT_TYPE_LABEL[agentType] || agentType) : 'TeamAgent';
  const identity = name || teamName || '';
  const shortDesc = description || (prompt ? (prompt.length > 50 ? prompt.slice(0, 47) + '...' : prompt) : '');
  const headerText = [label, identity, shortDesc].filter(Boolean).join(' · ');

  const isBackground = props.result?.metadata?.background === true;

  const doneToolCalls: ToolCallSummary[] = (props.result?.metadata?.toolCalls as ToolCallSummary[]) ?? [];
  const doneTurnCount = props.result?.metadata?.turnCount as number | undefined;
  const doneToolCount = props.result?.metadata?.toolCount as number | undefined;

  // Elapsed timer
  const nowRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      nowRef.current = Date.now();
      setNow(Date.now());
    }, 100);
    return () => clearInterval(id);
  }, []);
  const elapsedSecs = props.duration
    ? (props.duration / 1000).toFixed(1)
    : '0.0';

  // Poll registry for live tool calls and counts during execution.
  const liveCallsRef = useRef<ToolCallSummary[]>([]);
  const liveCountsRef = useRef<{ turnCount: number; toolCount: number }>({ turnCount: 0, toolCount: 0 });
  const [liveTick, setLiveTick] = useState(0);
  // Background agents keep polling even after the tool_use block is "done"
  const [bgRunning, setBgRunning] = useState(isBackground);
  const isActive = isExecuting || isPending || (isDone && isBackground);

  useEffect(() => {
    if (!isActive) return;

    function poll() {
      try {
        const registry = getSubAgentRegistry();
        if (!registry) return;

        const running = registry.list().filter(a => a.status === 'running');
        const matching = running.filter(a => {
          return props.toolId ? a.toolUseId === props.toolId : false;
        });

        const agent = matching[0];
        if (!agent) {
          if (isBackground) setBgRunning(false);
          return;
        }

        let changed = false;
        if (agent.liveToolCalls && agent.liveToolCalls.length > liveCallsRef.current.length) {
          liveCallsRef.current = [...agent.liveToolCalls];
          changed = true;
        }
        if (agent.turnCount !== liveCountsRef.current.turnCount || agent.toolCount !== liveCountsRef.current.toolCount) {
          liveCountsRef.current = { turnCount: agent.turnCount, toolCount: agent.toolCount };
          changed = true;
        }
        if (changed) setLiveTick(t => t + 1);
      } catch {
        // Ignore poll errors
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [isActive]);

  // Seed liveCallsRef from done result so we don't lose data on re-render
  if (isDone && doneToolCalls.length > liveCallsRef.current.length) {
    liveCallsRef.current = doneToolCalls;
  }

  const displayCalls = liveCallsRef.current.length > 0 ? liveCallsRef.current : doneToolCalls;
  const lastCall = displayCalls.length > 0 ? displayCalls[displayCalls.length - 1] : null;

  const turnCount = isDone ? (doneTurnCount ?? liveCountsRef.current.turnCount) : liveCountsRef.current.turnCount;
  const toolCount = isDone ? (doneToolCount ?? liveCountsRef.current.toolCount) : liveCountsRef.current.toolCount;
  const showCounts = turnCount > 0 || toolCount > 0;

  const blinkOn = Math.floor(now / 500) % 2 === 0;
  const trulyDone = isDone && !bgRunning;
  const indicator = trulyDone ? '●' : (blinkOn ? '●' : '○');
  const indicatorColor = trulyDone ? 'ansi:green' : 'ansi:yellow';
  const statusText = isPending ? 'queued' : (bgRunning ? 'background' : '');
  const showTimer = (isExecuting || isPending || bgRunning) && !trulyDone;

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>{headerText}</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>{headerText}</Text>
        {showCounts ? (
          <Text dimColor> · {toolCount} tools, {turnCount} turns</Text>
        ) : null}
        {showTimer ? (
          <Text dimColor color="ansi:yellow"> · {statusText} {elapsedSecs}s</Text>
        ) : null}
        {isolation ? <Text dimColor> · isolated: {isolation}</Text> : null}
        {trulyDone ? <Text dimColor> · {props.duration ? `${(props.duration / 1000).toFixed(1)}s` : elapsedSecs + 's'}</Text> : null}
      </Text>
      {lastCall && (
        <Box flexDirection="column" marginLeft={2}>
          <Text>
            <Text dimColor>└ </Text>
            <Text bold>{toolLabel(lastCall.name)}</Text>
            <Text dimColor>({formatToolCallDetail(lastCall)})</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
