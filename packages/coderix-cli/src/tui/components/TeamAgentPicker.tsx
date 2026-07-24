import { useEffect, useState } from 'react';
import { Box, Text, useInput } from '@coderix/ink';
import type { Color } from '@coderix/ink';
import { listTeams, loadTeamConfig } from '@coderix/core';
import { getSubAgentRegistry } from '@coderix/core';
import type { TeamMember } from '@coderix/core';
import type { SubAgentRecord } from '@coderix/core';

const AGENT_ICONS: Record<string, string> = {
  explore: '\u{1F50D}',
  plan: '\u{1F4CB}',
  'general-purpose': '\u{1F527}',
};

const STATUS_ICON: Record<string, string> = {
  running: '◉',
  done: '●',
  error: '✕',
  stopped: '■',
};

const STATUS_COLOR: Record<string, string> = {
  running: 'ansi:yellow',
  done: 'ansi:green',
  error: 'ansi:red',
  stopped: 'ansi:blackBright',
};

interface SelectableMember {
  member: TeamMember;
  teamName: string;
}

function agentToMember(agent: SubAgentRecord): TeamMember {
  const statusMap: Record<string, TeamMember['status']> = {
    running: 'running',
    done: 'done',
    error: 'error',
    stopped: 'stopped',
  };
  return {
    agentId: agent.id,
    name: agent.name || agent.agentType,
    agentType: agent.agentType,
    status: statusMap[agent.status] ?? 'done',
    task: agent.prompt.slice(0, 80),
    joinedAt: agent.createdAt,
  };
}

interface TeamAgentPickerProps {
  onSelect: (agentId: string) => void;
  onCancel: () => void;
  sessionDir?: string;
}

/**
 * Overlay picker for selecting a team member to view their transcript.
 * Shows all selectable team members (running or done, with valid agentIds).
 *
 * Keyboard:
 *   Up/Down  — navigate
 *   Enter    — select (open transcript)
 *   Esc      — cancel
 *   1-9      — quick pick
 */
export function TeamAgentPicker({ onSelect, onCancel, sessionDir }: TeamAgentPickerProps) {
  const [members, setMembers] = useState<SelectableMember[]>([]);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    async function load() {
      if (!sessionDir) return;
      const registry = getSubAgentRegistry();
      const result: SelectableMember[] = [];
      const teamAgentIds = new Set<string>();

      // Team members from disk configs
      const names = await listTeams(sessionDir);
      for (const name of names) {
        const cfg = await loadTeamConfig(sessionDir, name);
        if (!cfg) continue;
        for (const m of cfg.members) {
          if (m.agentId && !m.agentId.startsWith('pending-')) {
            teamAgentIds.add(m.agentId);
          }
          if (
            (m.status === 'running' || m.status === 'done') &&
            !m.agentId.startsWith('pending-') &&
            registry?.get(m.agentId)
          ) {
            result.push({ member: m, teamName: name });
          }
        }
      }

      // Solo agents from registry (not part of any team)
      if (registry) {
        for (const agent of registry.list()) {
          if (
            !teamAgentIds.has(agent.id) &&
            (agent.status === 'running' || agent.status === 'done')
          ) {
            result.push({ member: agentToMember(agent), teamName: 'solo' });
          }
        }
      }

      setMembers(result);
    }
    load();
  }, []);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.return) {
      const item = members[sel];
      if (item) onSelect(item.member.agentId);
      return;
    }

    if (key.upArrow && sel > 0) {
      setSel(s => s - 1);
      return;
    }

    if (key.downArrow && sel < members.length - 1) {
      setSel(s => s + 1);
      return;
    }

    // Number keys quick-pick
    const n = parseInt(_input, 10);
    if (n >= 1 && n <= members.length) {
      const item = members[n - 1];
      if (item) onSelect(item.member.agentId);
    }
  });

  if (members.length === 0) {
    return (
      <Box borderStyle="double" borderColor="ansi:cyan" flexDirection="column" paddingX={1}>
        <Text bold color="ansi:cyan">Team Members</Text>
        <Text dimColor>No selectable members.</Text>
        <Text dimColor>Sub-agents and team members will appear here when they are running.</Text>
        <Text>{' '}</Text>
        <Text dimColor>Press Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="double" borderColor="ansi:cyan" flexDirection="column" paddingX={1}>
      <Text bold color="ansi:cyan">
        Team Members ({members.length}) — select to view transcript
      </Text>

      <Text>{' '}</Text>

      {members.map((item, i) => {
        const { member: m, teamName } = item;
        const icon = AGENT_ICONS[m.agentType] ?? '\u{1F916}';
        const statusIcon = STATUS_ICON[m.status] ?? '?';
        const statusColor = (STATUS_COLOR[m.status] ?? 'ansi:white') as Color;
        const isSelected = sel === i;
        const label = m.task ? `${m.task.slice(0, 50)}` : m.name;

        return (
          <Text key={`${teamName}-${m.agentId}`}>
            <Text
              bold={isSelected}
              color={isSelected ? 'ansi:cyan' : undefined}
              inverse={isSelected}
            >
              {isSelected ? '> ' : '  '}
              {i + 1}. {icon} {m.name}
              {'  '}
              <Text color={statusColor}>{statusIcon} {m.status}</Text>
              {'  '}
              <Text dimColor>{m.agentType}</Text>
              {'  '}
              <Text dimColor>{teamName}</Text>
            </Text>
          </Text>
        );
      })}

      <Text>{' '}</Text>
      <Text dimColor>
        Up/Down select · Enter confirm · 1-9 quick pick · Esc cancel
      </Text>
    </Box>
  );
}
