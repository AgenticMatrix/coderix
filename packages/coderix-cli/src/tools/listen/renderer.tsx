import React, { useState, useEffect } from 'react';
import { Box, Text } from '@coderix/ink';
import { getSubAgentRegistry } from '@coderix/core';
import type { SubAgentRecord } from '@coderix/core';
import type { ToolUseRendererProps, ToolResultRendererProps } from '../types.js';
import { useToolTimer } from '../shared/useToolTimer.js';

const AGENT_TYPE_LABEL: Record<string, string> = {
  explore: 'Explore',
  plan: 'Plan',
  'general-purpose': 'General Purpose',
  fork: 'Fork',
};

const POLL_MS = 250;

interface AgentSnapshot {
  id: string;
  agentType: string;
  latestTool: string | null;
}

export function ListenRenderer(props: ToolUseRendererProps) {
  const isDone = props.state === 'done';
  const isExecuting = props.state === 'executing';
  const isPending = props.state === 'pending';
  const isActive = isExecuting || isPending;
  const resultContent = props.result?.content;

  const { elapsedSecs, blinkOn } = useToolTimer(isActive);

  const [agents, setAgents] = useState<AgentSnapshot[]>([]);

  useEffect(() => {
    if (!isActive) return;

    function poll() {
      try {
        const registry = getSubAgentRegistry();
        if (!registry) return;

        const running = registry.list().filter((a: SubAgentRecord) => a.status === 'running');
        const snapshots: AgentSnapshot[] = running.map((a: SubAgentRecord) => ({
          id: a.id,
          agentType: a.agentType,
          latestTool: a.liveToolCalls?.length
            ? a.liveToolCalls[a.liveToolCalls.length - 1].name
            : null,
        }));
        setAgents(snapshots);
      } catch {
        // Ignore poll errors
      }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, [isActive]);

  // Title bar
  const statusIcon = isActive
    ? (blinkOn ? '●' : '○')
    : '●';
  const statusColor = isActive ? 'ansi:yellow' : 'ansi:green';

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
            <Text dimColor> · ⏱ {isActive ? elapsedSecs : ((props.duration ?? 0) / 1000).toFixed(1)}/{(props.input.duration as number) ?? 0}</Text>
          </Text>
        </Box>
      </Box>

      {/* Body — aligned under L in Listen (icon width = 2) */}
      {isActive && agents.length > 0 ? (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexDirection="column">
            {agents.map((a, i) => (
              <Box key={a.id} flexDirection="row">
                <Text dimColor>{i === agents.length - 1 ? '⎿' : '│'} </Text>
                <Text dimColor>{AGENT_TYPE_LABEL[a.agentType] || a.agentType}</Text>
                <Text dimColor> {a.id.slice(0, 12)}</Text>
                {a.latestTool ? (
                  <Text dimColor> · {a.latestTool}</Text>
                ) : null}
                <Text dimColor> running</Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : isDone && resultContent ? (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexDirection="column">
            <Text dimColor>└ {resultContent}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Result renderer that suppresses the default content display,
 * since the tool-use renderer already shows the result.
 */
export function ListenResultRenderer(_props: ToolResultRendererProps) {
  return null;
}
