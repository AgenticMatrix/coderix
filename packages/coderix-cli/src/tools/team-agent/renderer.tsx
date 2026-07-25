import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
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

  // Build header: TeamAgent(description, name, team, prompt preview)
  const promptPreview = prompt ? (prompt.length > 20 ? prompt.slice(0, 17) + '...' : prompt) : '';
  const headerParts = [description, name, teamName, promptPreview].filter(Boolean);
  const headerText = 'TeamAgent' + (headerParts.length > 0 ? `(${headerParts.join(', ')})` : '');

  const isBackground = props.result?.metadata?.background === true;

  const doneToolCalls: ToolCallSummary[] = (props.result?.metadata?.toolCalls as ToolCallSummary[]) ?? [];
  const doneTurnCount = props.result?.metadata?.turnCount as number | undefined;
  const doneToolCount = props.result?.metadata?.toolCount as number | undefined;

  // Track elapsed time from tool execution
  const elapsedSecs = props.duration
    ? (props.duration / 1000).toFixed(1)
    : '0.0';

  // Poll registry for live tool calls and counts.
  // Unlike regular sub-agents, team agents keep running (idle loop) even after
  // the tool call returns. Continue polling as long as the agent is alive.
  const liveCallsRef = useRef<ToolCallSummary[]>([]);
  const liveCountsRef = useRef<{ turnCount: number; toolCount: number }>({ turnCount: 0, toolCount: 0 });
  const [liveTick, setLiveTick] = useState(0);
  const [agentAlive, setAgentAlive] = useState(true);
  const isActive = isExecuting || isPending || agentAlive;

  useEffect(() => {
    if (!isActive) return;

    function poll() {
      try {
        const registry = getSubAgentRegistry();
        if (!registry) return;

        const agent = registry.list().find(a => {
          return props.toolId ? a.toolUseId === props.toolId : false;
        });

        if (!agent) {
          // Agent removed from registry — stop polling
          if (isDone || hasResult) setAgentAlive(false);
          return;
        }

        if (agent.status === 'done' || agent.status === 'error' || agent.status === 'stopped') {
          setAgentAlive(false);
          return;
        }

        let changed = false;
        if (agent.liveToolCalls && agent.liveToolCalls.length > 0) {
          // Accumulate tools across turns — registry clears liveToolCalls each turn,
          // so we merge instead of replace to show all tools seen so far.
          const seen = new Set(liveCallsRef.current.map(tc => tc.name + tc.input));
          for (const tc of agent.liveToolCalls) {
            const key = tc.name + tc.input;
            if (!seen.has(key)) {
              liveCallsRef.current = [...liveCallsRef.current, tc];
              seen.add(key);
              changed = true;
            }
          }
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

  // Prefer doneToolCalls when done (has complete list from extractToolCalls),
  // fall back to liveCallsRef for real-time polling during execution.
  const displayCalls = (isDone && doneToolCalls.length > 0) ? doneToolCalls : liveCallsRef.current;
  const lastCall = displayCalls.length > 0 ? displayCalls[displayCalls.length - 1] : null;

  const turnCount = isDone ? (doneTurnCount ?? liveCountsRef.current.turnCount) : liveCountsRef.current.turnCount;
  const toolCount = isDone ? (doneToolCount ?? liveCountsRef.current.toolCount) : liveCountsRef.current.toolCount;
  const showCounts = turnCount > 0 || toolCount > 0;

  const blinkOn = Math.floor(Date.now() / 500) % 2 === 0;
  const indicator = agentAlive ? (blinkOn ? '●' : '○') : '●';
  const indicatorColor = agentAlive ? 'ansi:yellow' : 'ansi:green';
  const showTimer = agentAlive;

  // Tool call list: collapsed shows latest + hint, expanded shows all
  const expanded = props.contentExpanded;
  const hasToolCalls = displayCalls.length > 0;
  const visibleCalls = expanded ? displayCalls : (lastCall ? [lastCall] : []);
  const hiddenCount = displayCalls.length - visibleCalls.length;

  // Prompt expand via Ctrl+D — only when no tool calls
  const promptExpanded = props.contentExpanded;
  const promptLines = prompt ? prompt.split('\n') : [];
  const displayLines = promptExpanded ? promptLines : promptLines.slice(0, 1);
  const hidden = promptLines.length - displayLines.length;

  if (isError) {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Text>
          <Text color="ansi:red">✕ </Text>
          <Text bold>{headerText}</Text>
          <Text color="ansi:red"> failed</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* Header line */}
      <Text>
        <Text color={indicatorColor}>{indicator} </Text>
        <Text bold>{headerText}</Text>
        {showCounts ? (
          <Text dimColor> · {toolCount} tools, {turnCount} turns</Text>
        ) : null}
        {showTimer ? (
          <Text dimColor color="ansi:yellow"> · {elapsedSecs}s</Text>
        ) : (
          <Text dimColor> · {elapsedSecs}s</Text>
        )}
        {isolation ? <Text dimColor> · isolated: {isolation}</Text> : null}
      </Text>
      {/* Tool call list — collapsed vs expanded */}
      {hasToolCalls && visibleCalls.map((tc, i) => (
        <Box key={i} flexDirection="column" marginLeft={2}>
          <Text>
            <Text dimColor>⎿ </Text>
            <Text bold>{toolLabel(tc.name)}</Text>
            <Text dimColor>({formatToolCallDetail(tc)})</Text>
          </Text>
        </Box>
      ))}
      {!expanded && hiddenCount > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>  {hiddenCount} more lines, Ctrl+D to detail</Text>
        </Box>
      )}
      {/* Prompt detail — shown when no tool calls and prompt is available */}
      {!hasToolCalls && displayLines.length > 0 && (
        <Box flexDirection="column">
          {displayLines.map((line, i) => (
            <Text key={i} dimColor>{i === 0 ? '└ ' : '  '}{line.length > 120 ? line.slice(0, 117) + '...' : line}</Text>
          ))}
          {hidden > 0 ? (
            <Text dimColor>  ... {hidden} more lines, Ctrl+D to detail</Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
