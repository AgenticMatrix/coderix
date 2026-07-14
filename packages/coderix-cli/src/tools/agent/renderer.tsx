import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
import { useToolTimer } from '../shared/useToolTimer.js';
import type { ToolUseRendererProps } from '../types.js';

const AGENT_TYPE_LABEL: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  'general-purpose': 'General Purpose',
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
    parts.push(keyValue.length > 50 ? keyValue.slice(0, 47) + '...' : keyValue);
  } else if (!desc) {
    // Fallback: show a short summary of the input
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
const FOLD_THRESHOLD = 5;

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
  const { elapsedSecs, blinkOn } = useToolTimer(isExecuting || isPending);

  const isResume = !!(props.input.resume) && !!(props.input.agent_id);
  const label = isResume ? 'Resume' : (agentType ? (AGENT_TYPE_LABEL[agentType] || agentType) : 'Fork');
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
            if (isResume && props.input.agent_id) {
              return a.id === props.input.agent_id;
            }
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
  const tooLong = displayCalls.length > FOLD_THRESHOLD && !props.contentExpanded;
  const visibleCalls = tooLong ? displayCalls.slice(0, FOLD_THRESHOLD) : displayCalls;
  const hiddenCount = displayCalls.length - FOLD_THRESHOLD;

  const resultContent = props.result?.content;
  const resultFirstLine = resultContent ? resultContent.split('\n')[0]?.trim() : null;
  const resultPreview = resultFirstLine
    ? (resultFirstLine.length > 100 ? resultFirstLine.slice(0, 97) + '...' : resultFirstLine)
    : null;

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

  const indicator = isDone ? '●' : (blinkOn ? '●' : '○');
  const indicatorColor = isDone ? 'ansi:green' : 'ansi:yellow';
  const statusText = isPending ? 'queued' : '';
  const showTimer = (isExecuting || isPending) && !isDone;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>{headerText}</Text>
        {showTimer ? (
          <Text dimColor color="ansi:yellow"> {statusText} {elapsedSecs}s</Text>
        ) : null}
        {isolation ? <Text dimColor> isolated: {isolation}</Text> : null}
        {isDone ? <Text dimColor> · {props.duration ? `${(props.duration / 1000).toFixed(1)}s` : ''}</Text> : null}
      </Text>
      {displayCalls.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {visibleCalls.map((tc, i) => {
            const prefix = tooLong ? '├── ' : (i === visibleCalls.length - 1 ? '└── ' : '├── ');
            const detail = formatToolCallDetail(tc);
            return (
              <Text key={i}>
                <Text dimColor>{prefix}</Text>
                <Text bold>{toolLabel(tc.name)}</Text>
                <Text dimColor>({detail})</Text>
              </Text>
            );
          })}
          {tooLong && (
            <Text dimColor>... {hiddenCount} more lines (Ctrl+D to detail)</Text>
          )}
        </Box>
      )}
      {resultPreview && (
        <Box marginLeft={1}>
          <Text dimColor>{resultPreview}</Text>
        </Box>
      )}
    </Box>
  );
}
