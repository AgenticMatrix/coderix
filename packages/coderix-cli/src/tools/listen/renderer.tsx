import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
import { listTasks as listTrackedTasks } from '@coderix/core/tasks/task-tracker';
import type { ToolUseRendererProps, ToolResultRendererProps } from '../types.js';

const AGENT_TYPE_LABEL: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  'general-purpose': 'General Purpose',
  fork: 'Fork',
};

const POLL_MS = 250;
const AUTO_INCREMENT = 5;

interface ProcessSnapshot {
  id: string;
  label: string;
  detail: string;
}

export function ListenRenderer(props: ToolUseRendererProps) {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isActive = isExecuting || isPending;
  const attempts = props.result?.metadata?.attempts as
    | { attempt: number; duration: number; actualDuration: number; wokeEarly: boolean; runningSummary: string }[]
    | undefined;

  // Manual ref-based timer so elapsed resets synchronously on retry,
  // avoiding the one-frame stale-timer leak that useToolTimer's
  // useEffect-based reset causes.
  const startTimeRef = useRef(Date.now());
  const prevRetryRef = useRef(attempts?.length ?? 0);
  const currentRetry = attempts?.length ?? 0;
  if (isActive && currentRetry !== prevRetryRef.current) {
    startTimeRef.current = Date.now();
    prevRetryRef.current = currentRetry;
  }
  const [, tick] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => tick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [isActive]);

  const blinkOn = Math.floor(tick / 5) % 2 === 0;

  const [processes, setProcesses] = useState<ProcessSnapshot[]>([]);
  const lastProcessesRef = useRef<ProcessSnapshot[]>([]);

  useEffect(() => {
    if (!isActive) return;

    function poll() {
      const snapshots: ProcessSnapshot[] = [];

      try {
        const registry = getSubAgentRegistry();
        if (registry) {
          for (const a of registry.list()) {
            if (a.status === 'running') {
              const label = AGENT_TYPE_LABEL[a.agentType] || a.agentType;
              const tool = a.liveToolCalls?.length
                ? ` · ${a.liveToolCalls[a.liveToolCalls.length - 1].name}`
                : '';
              snapshots.push({
                id: a.id,
                label,
                detail: `${a.id.slice(0, 12)}${tool}`,
              });
            }
          }
        }
      } catch { /* ignore */ }

      try {
        for (const t of listTrackedTasks()) {
          if (t.type === 'bash' && t.status === 'running') {
            snapshots.push({
              id: t.id,
              label: 'Bash',
              detail: t.description || t.id.slice(0, 12),
            });
          }
        }
      } catch { /* ignore */ }

      setProcesses(snapshots);
      if (snapshots.length > 0) lastProcessesRef.current = snapshots;
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [isActive]);

  // Cumulative tracking across auto-retry attempts.
  const retryCount = currentRetry;
  const attemptCount = isDone ? (retryCount || 1) : retryCount + 1;
  const pastElapsed = (props.result?.metadata?.totalDuration as number) ?? 0;
  const currentElapsed = isActive ? (Date.now() - startTimeRef.current) / 1000 : 0;
  const cumulativeElapsed = isDone
    ? (pastElapsed || currentElapsed)
    : pastElapsed + currentElapsed;

  const originalDuration = (props.input.duration as number) ?? 0;
  const cumulativeTotal =
    attemptCount * originalDuration +
    (AUTO_INCREMENT * attemptCount * (attemptCount - 1)) / 2;

  const statusIcon = isActive ? (blinkOn ? '●' : '○') : '●';
  const statusColor = isActive ? 'ansi:yellow' : 'ansi:green';

  const displayProcesses = isActive ? processes : lastProcessesRef.current;

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* Title bar */}
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={statusColor}>{statusIcon}</Text>
        </Box>
        <Box flexDirection="row" flexGrow={1}>
          <Text>
            <Text bold>Listen</Text>
            <Text dimColor>
              {' '}for {attemptCount} times, duration {cumulativeElapsed.toFixed(1)}/{cumulativeTotal.toFixed(0)}s
            </Text>
          </Text>
        </Box>
      </Box>

      {/* Body — monitored processes */}
      {displayProcesses.length > 0 ? (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexDirection="column" flexGrow={1}>
            {displayProcesses.map((p, i) => (
              <Box key={p.id} flexDirection="row">
                <Text dimColor>{i === displayProcesses.length - 1 ? '└' : '│'} </Text>
                <Text bold>{p.label}</Text>
                <Text dimColor> ({p.detail} {isActive ? 'running' : 'completed'})</Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function ListenResultRenderer(_props: ToolResultRendererProps) {
  return null;
}
