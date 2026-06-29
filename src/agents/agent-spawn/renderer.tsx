import { createElement, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ShellTimeDisplay, formatDuration } from '../../tools/shared/ShellTimeDisplay.js';
import type { ToolUseRenderer } from '../../tools/types.js';
import { getSubAgentRegistry } from './registry-ref.js';

const AGENT_ICONS: Record<string, string> = {
  explore: '🔍',
  plan: '📋',
  'general-purpose': '🔧',
};

const AGENT_LABELS: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  'general-purpose': 'General-purpose',
};

const RESULT_COLLAPSE = 12;

const SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];

export const AgentSpawnRenderer: ToolUseRenderer = (props) => {
  const prompt = props.input.prompt as string ?? '';
  const agentType = props.input.agent_type as string ?? 'general-purpose';
  const icon = AGENT_ICONS[agentType] ?? '🤖';
  const label = AGENT_LABELS[agentType] ?? agentType;
  const summary = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt;

  // Render a minimal placeholder while the LLM is still streaming input.
  if (props.state === 'pending') {
    return createElement(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'grey', paddingX: 1, width: '90%' },
      createElement(Text, { dimColor: true }, `${icon} ${label}: ${summary || '...'}`),
    );
  }

  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const resultContent: string | undefined = isDone ? (props.result?.content as string) : undefined;
  const resultLines = resultContent ? resultContent.split('\n') : [];
  const tooLong = !props.contentExpanded && resultLines.length > RESULT_COLLAPSE;
  const displayLines = tooLong ? resultLines.slice(0, RESULT_COLLAPSE) : resultLines;

  // ── Live elapsed timer ──────────────────────────────────────
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isExecuting) return;
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - start), 100);
    return () => clearInterval(timer);
  }, [isExecuting]);

  // ── Live turn / tool counts from registry ───────────────────
  const [liveStats, setLiveStats] = useState<{ turnCount: number; toolCount: number } | null>(null);
  useEffect(() => {
    if (!isExecuting) return;
    const registry = getSubAgentRegistry();
    if (!registry) return;

    const poll = () => {
      const agents = registry.listByStatus('running');
      const match = agents.find(a => a.prompt === prompt && a.agentType === agentType);
      if (match) {
        setLiveStats({ turnCount: match.turnCount, toolCount: match.toolCount });
      }
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => clearInterval(timer);
  }, [isExecuting, prompt, agentType]);

  // ── Spinner animation ──────────────────────────────────────
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  useEffect(() => {
    if (!isExecuting) return;
    const timer = setInterval(() => setSpinnerIdx(i => (i + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, [isExecuting]);

  // ── Duration display value ──────────────────────────────────
  const displayDuration = isDone && props.duration !== undefined
    ? props.duration
    : isExecuting ? elapsed : undefined;

  // ── Progress line ───────────────────────────────────────────
  let progressNode: ReactNode = null;
  if (isExecuting) {
    if (liveStats && liveStats.turnCount > 0) {
      progressNode = createElement(
        Text,
        { color: 'yellow' },
        `  ${liveStats.turnCount} LLM turns, ${liveStats.toolCount} tools used.`,
      );
    } else {
      progressNode = createElement(Text, { color: 'yellow' }, '  Running...');
    }
  }

  return createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: isExecuting ? 'yellow' : props.state === 'error' ? 'red' : 'blue',
      paddingX: 1,
      width: '90%',
    },
    // Header: icon + label | duration
    createElement(
      Box,
      { flexDirection: 'row', justifyContent: 'space-between' },
      createElement(Text, { bold: true, color: 'cyan' }, isExecuting ? `${SPINNER_FRAMES[spinnerIdx]} ${label}` : `${icon} ${label}`),
      displayDuration !== undefined
        ? isExecuting
          ? createElement(Text, { dimColor: true }, `⏱ ${formatDuration(displayDuration)}`)
          : createElement(ShellTimeDisplay, { durationMs: displayDuration })
        : null,
    ),
    // Prompt summary
    createElement(Text, { dimColor: true }, summary),
    // Progress indicator (live turn/tool counts or Running...)
    progressNode,
    // Done: show result content inside the same box
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
    // View transcript hint
    isDone && createElement(Text, { dimColor: true }, '  Ctrl+T to view full transcript'),
    // Error
    props.state === 'error' && props.result?.isError &&
      createElement(Text, { color: 'red' }, `  Error: ${(props.result.content as string).slice(0, 100)}`),
  );
};
