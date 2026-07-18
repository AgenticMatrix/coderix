import { useEffect, useState, useRef } from 'react';
import { Box, Text, useInput } from '@coderix/ink';
import { listTeams, loadTeamConfig } from '@coderix/core';
import { getSubAgentRegistry } from '@coderix/core';
import type { TeamConfig, TeamMember } from '@coderix/core';
import type { SubAgentRecord } from '@coderix/core';

import type { TeamContextState } from '@coderix/core';

function formatDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remain = Math.floor(secs % 60);
  return `${mins}m ${remain}s`;
}

function statusLabel(m: TeamMember, now: number, stats?: LiveAgentStats): string {
  const elapsed = m.finishedAt ? m.finishedAt - m.joinedAt : now - m.joinedAt;
  switch (m.status) {
    case 'running': {
      const hasLiveCalls = stats && stats.lastCall !== null;
      if (!hasLiveCalls) return 'idle';
      return `running ${formatDuration(elapsed)}`;
    }
    case 'pending':
      return 'pending';
    case 'done':
      return `done ${formatDuration(elapsed)}`;
    case 'error':
      return `error ${formatDuration(elapsed)}`;
    case 'stopped':
      return `stopped ${formatDuration(elapsed)}`;
    default:
      return m.status;
  }
}

interface TeamPanelProps {
  dismissed: boolean;
  onDismissReset?: () => void;
  focused: boolean;
  onFocusRequest: () => void;
  onSelect: (agentId: string) => void;
  viewedAgentId?: string | null;
  /** Active team context — enables team-specific display. */
  teamContext?: TeamContextState;
}

const POLL_INTERVAL_MS = 2000;
const LIVE_POLL_MS = 500;

interface LiveAgentStats {
  turnCount: number;
  toolCount: number;
  lastCall: string | null;
}

function formatToolCallDetail(name: string, input: string): string {
  let inputObj: Record<string, unknown> | null = null;
  try {
    inputObj = JSON.parse(input);
  } catch {
    return input.length > 50 ? input.slice(0, 47) + '...' : input;
  }

  const keyParam = TOOL_KEY_PARAM[name];
  if (keyParam) {
    const val = inputObj?.[keyParam] as string | undefined;
    if (val) return val.length > 90 ? val.slice(0, 87) + '...' : val;
  }

  const desc = inputObj?.description as string | undefined;
  if (desc) return desc.length > 90 ? desc.slice(0, 87) + '...' : desc;

  return input.length > 50 ? input.slice(0, 47) + '...' : input;
}

const TOOL_KEY_PARAM: Record<string, string> = {
  bash: 'command',
  read: 'file_path',
  grep: 'pattern',
  glob: 'pattern',
  write: 'file_path',
  update: 'file_path',
  edit: 'file_path',
  WebSearch: 'query',
  WebFetch: 'url',
};

function agentToMember(agent: SubAgentRecord): TeamMember {
  const statusMap: Record<string, TeamMember['status']> = {
    running: 'running',
    done: 'done',
    error: 'error',
    stopped: 'stopped',
  };
  const isFork = agent.name.startsWith('fork-');
  const task = agent.description || (isFork ? '' : agent.prompt.slice(0, 80));
  return {
    agentId: agent.id,
    name: agent.name || agent.agentType,
    agentType: agent.agentType,
    status: statusMap[agent.status] ?? 'done',
    task,
    joinedAt: agent.createdAt,
    finishedAt: agent.finishedAt,
  };
}

/**
 * Team status panel pinned above the input box.
 * Read-only display — press Ctrl+J to open the TeamAgentPicker
 * for selecting a member to view their transcript.
 */
export function TeamPanel({ dismissed, onDismissReset, focused, onFocusRequest, onSelect, viewedAgentId, teamContext }: TeamPanelProps) {
  const [configs, setConfigs] = useState<TeamConfig[]>([]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const prevActiveCount = useRef(0);
  const hiddenTeams = useRef<Set<string>>(new Set());
  const prevFingerprint = useRef('');
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  // Tick every second while any agent is running, to update elapsed timers
  const [now, setNow] = useState(Date.now());
  const hasRunning = configs.some(c => c.members.some(m => m.status === 'running' || m.status === 'pending'));
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  // Live agent stats (tool/turn counts, last tool call)
  const [liveStats, setLiveStats] = useState<Map<string, LiveAgentStats>>(new Map());
  useEffect(() => {
    const interval = setInterval(() => {
      const registry = getSubAgentRegistry();
      if (!registry) return;
      const next = new Map<string, LiveAgentStats>();
      for (const agent of registry.list()) {
        const calls = agent.liveToolCalls ?? [];
        const last = calls.length > 0 ? calls[calls.length - 1] : null;
        next.set(agent.id, {
          turnCount: agent.turnCount,
          toolCount: agent.toolCount,
          lastCall: last ? `${last.name}(${formatToolCallDetail(last.name, last.input)})` : null,
        });
      }
      setLiveStats(next);
    }, LIVE_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const registry = getSubAgentRegistry();
        const names = await listTeams();
        const loaded: TeamConfig[] = [];
        const teamAgentIds = new Set<string>();

        for (const name of names) {
          const cfg = await loadTeamConfig(name);
          if (cfg) {
            // Only show members whose agents exist in the in-memory registry.
            // Disk configs persist across sessions, but the registry does not.
            const liveMembers = cfg.members.filter((m) => {
              if (m.agentId.startsWith('pending-')) return true;
              if (focusedRef.current) return true;
              if (m.status === 'done' || m.status === 'error' || m.status === 'stopped') return false;
              return registry ? registry.get(m.agentId) !== undefined : false;
            }).map(m => ({ ...m, teamName: cfg.name }));
            for (const m of cfg.members) {
              if (m.agentId && !m.agentId.startsWith('pending-')) {
                teamAgentIds.add(m.agentId);
              }
            }
            if (liveMembers.length > 0) {
              loaded.push({ ...cfg, members: liveMembers });
            }
          }
        }

        // Solo agents from registry (not part of any team)
        if (registry) {
          const soloMembers: TeamMember[] = [];
          for (const agent of registry.list()) {
            if (!teamAgentIds.has(agent.id) && (focusedRef.current || agent.status === 'running')) {
              soloMembers.push(agentToMember(agent));
            }
          }
          if (soloMembers.length > 0) {
            loaded.push({
              name: 'solo',
              description: 'Directly spawned agents',
              createdAt: Date.now(),
              members: soloMembers,
            });
          }
        }

        if (!active) return;

        const fp = loaded.map(c => `${c.name}:${c.members.map(m => `${m.name}:${m.status}:${m.agentId}`).join(',')}`).join('|');
        if (fp !== prevFingerprint.current) {
          prevFingerprint.current = fp;
          setConfigs(loaded);
        }

        const activeCount = loaded.reduce(
          (sum, c) => sum + c.members.filter(m => m.status === 'running' || m.status === 'pending').length,
          0,
        );

        if (activeCount === 0 && prevActiveCount.current > 0) {
          for (const c of loaded) hiddenTeams.current.add(c.name);
        }

        if (activeCount > prevActiveCount.current && activeCount > 0) {
          if (dismissed) onDismissReset?.();
          if (prevActiveCount.current === 0) {
            hiddenTeams.current = new Set();
          }
        }

        prevActiveCount.current = activeCount;
      } catch {
        // Silently ignore poll errors
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [dismissed, onDismissReset, focused]);

  const visible = focused ? configs : configs.filter(c => !hiddenTeams.current.has(c.name));
  const allMembers = visible.flatMap(c => c.members);
  const sorted = [...allMembers].sort((a, b) => {
    const order: Record<string, number> = { running: 0, pending: 1, done: 2, error: 3, stopped: 4 };
    return (order[a.status] ?? 2) - (order[b.status] ?? 2);
  });

  // Synthetic "main" entry for returning to the main agent
  const mainEntry: TeamMember = {
    agentId: '__main__',
    name: 'main',
    agentType: 'main',
    status: 'done',
    task: 'Return to main agent',
    joinedAt: 0,
  };
  const displayList = sorted.length > 0 ? [mainEntry, ...sorted] : [];

  // Keyboard navigation when focused
  useInput((_input, key) => {
    if (!focused || dismissed) return;

    if (key.escape) {
      onFocusRequest();
      return;
    }

    if (displayList.length === 0) return;

    if (key.return) {
      const member = displayList[cursorIndex];
      if (member) {
        if (member.agentId === '__main__') {
          onSelect('__main__');
        } else {
          onSelect(member.agentId);
        }
      }
      return;
    }

    if (key.upArrow) {
      if (cursorIndex > 0) {
        setCursorIndex(i => i - 1);
      } else {
        onFocusRequest();
      }
      return;
    }

    if (key.downArrow && cursorIndex < displayList.length - 1) {
      setCursorIndex(i => i + 1);
      return;
    }

    // Number keys quick-pick
    const n = parseInt(_input, 10);
    if (n >= 1 && n <= sorted.length) {
      const member = sorted[n - 1];
      if (member) onSelect(member.agentId);
    }
  });

  if (dismissed) return null;
  if (visible.length === 0) return null;

  const hasActive = allMembers.some(m => m.status === 'running' || m.status === 'pending');

  const runningCount = allMembers.filter(m => m.status === 'running').length;
  const pendingCount = allMembers.filter(m => m.status === 'pending').length;
  const doneCount = allMembers.filter(m => m.status === 'done').length;
  const errorCount = allMembers.filter(m => m.status === 'error').length;

  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} active`);
  if (pendingCount > 0) parts.push(`${pendingCount} pending`);
  if (doneCount > 0) parts.push(`${doneCount} done`);
  if (errorCount > 0) parts.push(`${errorCount} error`);

  return (
    <Box flexDirection="column" flexShrink={0} alignSelf="flex-start" paddingX={1} borderStyle="single" borderColor="ansi:blackBright">
      <Box>
        <Text bold>Agents </Text>
        <Text dimColor>({parts.join(', ')})</Text>
      </Box>
      {teamContext && (
        <Box>
          <Text dimColor>  Leader: {teamContext.isLeader ? 'you' : 'leader'} · {Object.keys(teamContext.teammates).length} worker(s)</Text>
        </Box>
      )}

      {displayList.slice(0, 9).map((m, i) => {
        // "main" entry for returning to the main agent
        if (m.agentId === '__main__') {
          const isCursor = focused && cursorIndex === i;
          const isViewed = !viewedAgentId;
          return (
            <Box key="__main__" flexShrink={0}>
              <Text>
                <Text dimColor={!isCursor} bold={isCursor}>
                  {isCursor ? '>' : ' '}
                </Text>
                {' '}
                <Text color={isViewed ? 'ansi:green' : 'ansi:blackBright'}>{isViewed ? '●' : '○'} </Text>
                <Text bold={isCursor}>main</Text>
                <Text dimColor> · Return to main agent (Enter toggle, Esc defocus)</Text>
              </Text>
            </Box>
          );
        }

        const isCursor = focused && cursorIndex === i;
        const isViewed = viewedAgentId === m.agentId;
        const icon = isViewed ? '●' : '○';
        const iconColor = isViewed ? 'ansi:green' : 'ansi:blackBright';
        const isAutoName = m.name.startsWith(`${m.agentType}-`) || m.name.startsWith('fork-');
        const teamOrSolo = m.teamName || 'solo';
        const middleLabel = isAutoName ? (m.task || m.name.slice(0, 50)) : m.name;
        const stats = m.status === 'running' ? liveStats.get(m.agentId) : undefined;
        const statusText = statusLabel(m, now, stats);
        const isIdle = stats && stats.lastCall === null;
        const statusColor = m.status === 'running' && !isIdle ? 'ansi:yellow' : m.status === 'error' ? 'ansi:red' : undefined;
        const statsSuffix = stats && (stats.turnCount > 0 || stats.toolCount > 0)
          ? ` · ${stats.toolCount} tools, ${stats.turnCount} turns${stats.lastCall ? ` · ${stats.lastCall}` : ''}`
          : '';

        return (
          <Box key={`${m.name}-${m.agentId}`} flexShrink={0}>
            <Text>
              <Text dimColor={!isCursor} bold={isCursor}>
                {isCursor ? '>' : ' '}
              </Text>
              {' '}
              <Text color={iconColor}>{icon} </Text>
              <Text bold={isCursor}>{m.agentType}</Text>
              <Text dimColor> · </Text>
              <Text dimColor={m.status === 'done'}>{teamOrSolo}</Text>
              <Text dimColor> · </Text>
              <Text dimColor={m.status === 'done'}>{middleLabel}</Text>
              <Text dimColor> · </Text>
              <Text color={statusColor} dimColor={m.status === 'done'}>{statusText}</Text>
              {statsSuffix ? (
                <Text dimColor>{statsSuffix}</Text>
              ) : null}
            </Text>
          </Box>
        );
      })}

      {sorted.length > 8 && (
        <Box>
          <Text dimColor>  ... and {sorted.length - 8} more</Text>
        </Box>
      )}

      {focused && (
        <Box>
          <Text dimColor>    Up/Down navigate · Enter select · Esc defocus</Text>
        </Box>
      )}
      {!focused && hasActive && (
        <Box>
          <Text dimColor>    Up/Down navigate · Ctrl+K to toggle filter</Text>
        </Box>
      )}
    </Box>
  );
}
