import { createElement, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ShellTimeDisplay, formatDuration } from '../../../tools/shared/ShellTimeDisplay.js';
import type { ToolUseRendererProps } from '../../../tools/types.js';
import { getSubAgentRegistry } from '../../../agents/agent-spawn/registry-ref.js';

const RESULT_COLLAPSE = 12;
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

export function SendMessageRenderer(props: ToolUseRendererProps): ReactNode {
  const hasAgentId = !!(props.input.agent_id as string);

  if (hasAgentId) {
    return AgentResumeView(props);
  }

  return TeamMessageView(props);
}

function TeamMessageView(props: ToolUseRendererProps): ReactNode {
  const to = props.input.to as string | undefined;
  const text = props.input.text as string | undefined;
  const isDone = props.state === 'done';
  const indicator = isDone ? '●' : '○';
  const color = isDone ? 'green' : 'magenta';
  const preview = text ? (text.length > 40 ? text.slice(0, 37) + '...' : text) : '';

  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(
      Text,
      null,
      createElement(Text, { color }, `${indicator} `),
      createElement(Text, { bold: true }, 'SendMessage'),
      to ? createElement(Text, { dimColor: true }, ` → ${to}`) : null,
      preview ? createElement(Text, { dimColor: true }, `: ${preview}`) : null,
    ),
  );
}

function AgentResumeView(props: ToolUseRendererProps): ReactNode {
  const agentId = props.input.agent_id as string ?? '?';
  const message = props.input.message as string ?? '';
  const summary = message.length > 80 ? message.slice(0, 77) + '...' : message;

  if (props.state === 'pending') {
    return createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'grey', paddingX: 1, width: '90%' },
      createElement(Text, { dimColor: true }, `💬 SendMessage → ${agentId}: ${summary || '...'}`),
    );
  }

  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const resultContent: string | undefined = isDone ? (props.result?.content as string) : undefined;
  const resultLines = resultContent ? resultContent.split('\n') : [];
  const tooLong = !props.contentExpanded && resultLines.length > RESULT_COLLAPSE;
  const displayLines = tooLong ? resultLines.slice(0, RESULT_COLLAPSE) : resultLines;

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isExecuting) return;
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - start), 100);
    return () => clearInterval(timer);
  }, [isExecuting]);

  const [liveStats, setLiveStats] = useState<{ turnCount: number; toolCount: number } | null>(null);
  useEffect(() => {
    if (!isExecuting) return;
    const registry = getSubAgentRegistry();
    if (!registry) return;
    const poll = () => {
      const agent = registry.get(agentId);
      if (agent && agent.status === 'running') {
        setLiveStats({ turnCount: agent.turnCount, toolCount: agent.toolCount });
      }
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => clearInterval(timer);
  }, [isExecuting, agentId]);

  const [spinnerIdx, setSpinnerIdx] = useState(0);
  useEffect(() => {
    if (!isExecuting) return;
    const timer = setInterval(() => setSpinnerIdx(i => (i + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, [isExecuting]);

  const displayDuration = isDone && props.duration !== undefined
    ? props.duration
    : isExecuting ? elapsed : undefined;

  let progressNode: ReactNode = null;
  if (isExecuting) {
    if (liveStats && liveStats.turnCount > 0) {
      progressNode = createElement(
        Text,
        { color: 'yellow' },
        `  ${liveStats.turnCount} LLM turns, ${liveStats.toolCount} tools used.`,
      );
    } else {
      progressNode = createElement(Text, { color: 'yellow' }, '  Continuing conversation...');
    }
  }

  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: isExecuting ? 'yellow' : props.state === 'error' ? 'red' : 'magenta',
      paddingX: 1,
      width: '90%',
    },
    createElement(
      Box,
      { flexDirection: 'row', justifyContent: 'space-between' },
      createElement(
        Text,
        { bold: true, color: 'cyan' },
        isExecuting
          ? `${SPINNER_FRAMES[spinnerIdx]} SendMessage → ${agentId}`
          : `💬 SendMessage → ${agentId}`,
      ),
      displayDuration !== undefined
        ? isExecuting
          ? createElement(Text, { dimColor: true }, `⏱ ${formatDuration(displayDuration)}`)
          : createElement(ShellTimeDisplay, { durationMs: displayDuration })
        : null,
    ),
    createElement(Text, { dimColor: true }, summary),
    progressNode,
    isDone && resultLines.length > 0 && createElement(
      Box,
      { paddingLeft: 1, flexDirection: 'column', marginTop: 0 },
      ...displayLines.map((line, i) =>
        createElement(Text, { key: i, color: 'white' }, line),
      ),
      tooLong && createElement(
        Text,
        { dimColor: true },
        `... ${resultLines.length - RESULT_COLLAPSE} more lines (Ctrl+D to detail)`,
      ),
    ),
    isDone && resultLines.length === 0 && createElement(Text, { color: 'green' }, '  Done'),
    props.state === 'error' && props.result?.isError &&
      createElement(Text, { color: 'red' }, `  Error: ${(props.result.content as string).slice(0, 100)}`),
  );
}
