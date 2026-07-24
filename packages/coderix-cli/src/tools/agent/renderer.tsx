import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
import type { ToolUseRendererProps } from '../types.js';

const AGENT_TYPE_LABEL: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  'general-purpose': 'General Purpose',
  fork_main: 'Fork',
  fork: 'Fork',
  resume: 'Resume',
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
    parts.push(keyValue.length > 90 ? keyValue.slice(0, 87) + '...' : keyValue);
  } else if (!desc) {
    // Fallback: show a short summary of the input
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

export function AgentRenderer(props: ToolUseRendererProps): React.ReactNode {
  const agentType = props.input.agent_type as string | undefined;
  const description = props.input.description as string | undefined;
  const prompt = props.input.prompt as string | undefined;
  const isolation = props.input.isolation as string | undefined;
  const hasResult = !!props.result;
  const isDone = props.state === 'done' || hasResult;
  const isExecuting = props.state === 'executing' && !hasResult;
  const isPending = props.state === 'pending' && !hasResult;
  const isError = props.state === 'error';

  // Derive elapsed time from the agent's createdAt registry timestamp
  // instead of a local counter, so the timer survives component remount
  // during sub-agent / main-agent view transitions.
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

  const isResume = !!(props.input.resume) && !!(props.input.agent_id);
  const label = isResume ? 'Resume' : (agentType ? (AGENT_TYPE_LABEL[agentType] || agentType) : 'Agent');
  const shortDesc = description || (prompt ? (prompt.length > 60 ? prompt.slice(0, 57) + '...' : prompt) : '');
  const headerText = shortDesc ? `${label} (${shortDesc})` : label;

  const isBackground = props.result?.metadata?.background === true;

  const doneToolCalls: ToolCallSummary[] = (props.result?.metadata?.toolCalls as ToolCallSummary[]) ?? [];
  const doneTurnCount = props.result?.metadata?.turnCount as number | undefined;
  const doneToolCount = props.result?.metadata?.toolCount as number | undefined;

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
        const matching = running
          .filter(a => {
            if (isResume && props.input.agent_id) {
              return a.id === props.input.agent_id;
            }
            return props.toolId ? a.toolUseId === props.toolId : false;
          });

        const agent = matching[0];
        if (!agent) {
          // Agent no longer in registry or completed — stop background polling
          if (isBackground) setBgRunning(false);
          return;
        }

        if (agent.createdAt) {
          createdAtRef.current = agent.createdAt;
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
  }, [isActive, agentType]);

  // Seed liveCallsRef from done result so we don't lose data on re-render
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
          <Text bold>{headerText}</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  // Background agents show live status even when tool_use block is "done"
  const trulyDone = isDone && !bgRunning;
  const indicator = trulyDone ? '●' : (blinkOn ? '●' : '○');
  const indicatorColor = trulyDone ? 'ansi:green' : 'ansi:yellow';
  const statusText = isPending ? 'queued' : (bgRunning ? 'background' : '');
  const showTimer = (isExecuting || isPending || bgRunning) && !trulyDone;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>{headerText}</Text>
        {showCounts ? (
          <Text dimColor> {toolCount} tools used, {turnCount} LLM turns,</Text>
        ) : null}
        {showTimer ? (
          <Text dimColor color="ansi:yellow"> {statusText} {elapsedSecs}s</Text>
        ) : null}
        {isolation ? <Text dimColor> isolated: {isolation}</Text> : null}
        {trulyDone ? <Text dimColor> {props.duration ? `${(props.duration / 1000).toFixed(1)}s` : ''}</Text> : null}
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
