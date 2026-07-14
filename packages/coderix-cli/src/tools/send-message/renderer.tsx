import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

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
    parts.push(keyValue.length > 50 ? keyValue.slice(0, 47) + '...' : keyValue);
  } else if (!desc) {
    const str = tc.input.length > 60 ? tc.input.slice(0, 57) + '...' : tc.input;
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

export function SendMessageRenderer(props: ToolUseRendererProps): React.ReactNode {
  const agentId = props.input.agent_id as string | undefined;
  const message = props.input.message as string | undefined;
  const teamName = props.input.team_name as string | undefined;
  const to = props.input.to as string | undefined;
  const text = props.input.text as string | undefined;

  const isResumeMode = !!(agentId && message);
  const isTeamMode = !!(teamName);

  const hasResult = !!props.result;
  const isDone = props.state === 'done' || hasResult;
  const isExecuting = props.state === 'executing' && !hasResult;
  const isPending = props.state === 'pending' && !hasResult;
  const isError = props.state === 'error';
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  // ── Team messaging mode ───────────────────────────────────────────────
  if (isTeamMode && !isResumeMode) {
    const recipient = to === '*' ? 'broadcast' : (to || '?');
    const preview = text ? (text.length > 80 ? text.slice(0, 77) + '...' : text) : '';
    const headerText = preview ? `→ ${recipient}: ${preview}` : `→ ${recipient}`;

    if (isError) {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color="ansi:red">❌ </Text>
            <Text bold>SendMessage</Text>
            <Text dimColor> {headerText}</Text>
            <Text color="ansi:red"> failed</Text>
          </Text>
        </Box>
      );
    }

    const indicator = isDone ? '●' : (blinkOn ? '●' : '○');
    const indicatorColor = isDone ? 'ansi:green' : 'ansi:yellow';
    const showTimer = (isExecuting || isPending) && !isDone;

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={indicatorColor}>{indicator} </Text>
          <Text bold>SendMessage</Text>
          <Text dimColor> {headerText}</Text>
          {showTimer ? (
            <Text dimColor color="ansi:yellow"> {elapsedSecs}s</Text>
          ) : null}
          {isDone ? <Text dimColor> · {props.duration ? `${(props.duration / 1000).toFixed(1)}s` : ''}</Text> : null}
        </Text>
      </Box>
    );
  }

  // ── Sub-agent resume mode ─────────────────────────────────────────────
  const headerText = `Resume ${agentId}${message ? ': ' + (message.length > 60 ? message.slice(0, 57) + '...' : message) : ''}`;

  const doneToolCalls: ToolCallSummary[] = (props.result?.metadata?.toolCalls as ToolCallSummary[]) ?? [];
  const doneTurnCount = props.result?.metadata?.turnCount as number | undefined;
  const doneToolCount = props.result?.metadata?.toolCount as number | undefined;

  const liveCallsRef = useRef<ToolCallSummary[]>([]);
  const liveCountsRef = useRef<{ turnCount: number; toolCount: number }>({ turnCount: 0, toolCount: 0 });
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
          .filter(a => agentId ? a.id === agentId : false)
          .sort((a, b) => b.createdAt - a.createdAt);

        const agent = matching[0];
        if (!agent) return;

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
  }, [isActive, agentId]);

  if (isDone && doneToolCalls.length > liveCallsRef.current.length) {
    liveCallsRef.current = doneToolCalls;
  }

  const displayCalls = liveCallsRef.current.length > 0 ? liveCallsRef.current : doneToolCalls;
  const lastCall = displayCalls.length > 0 ? displayCalls[displayCalls.length - 1] : null;

  const turnCount = isDone ? (doneTurnCount ?? liveCountsRef.current.turnCount) : liveCountsRef.current.turnCount;
  const toolCount = isDone ? (doneToolCount ?? liveCountsRef.current.toolCount) : liveCountsRef.current.toolCount;
  const showCounts = turnCount > 0 || toolCount > 0;

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color="ansi:red">❌ </Text>
          <Text bold>SendMessage</Text>
          <Text dimColor> {headerText}</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  const indicator = isDone ? '●' : (blinkOn ? '●' : '○');
  const indicatorColor = isDone ? 'ansi:green' : 'ansi:yellow';
  const statusText = isPending ? 'queued' : '';
  const showTimer = (isExecuting || isPending) && !isDone;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>SendMessage</Text>
        <Text dimColor> {headerText}</Text>
        {showCounts ? (
          <Text dimColor> {toolCount} tools used, {turnCount} LLM turns,</Text>
        ) : null}
        {showTimer ? (
          <Text dimColor color="ansi:yellow"> {statusText} {elapsedSecs}s</Text>
        ) : null}
        {isDone ? <Text dimColor> {props.duration ? `${(props.duration / 1000).toFixed(1)}s` : ''}</Text> : null}
      </Text>
      {lastCall && (
        <Box flexDirection="column" marginLeft={2}>
          <Text>
            <Text dimColor>└── </Text>
            <Text bold>{toolLabel(lastCall.name)}</Text>
            <Text dimColor>({formatToolCallDetail(lastCall)})</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
