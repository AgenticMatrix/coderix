/**
 * Swarm teammate spawn — in-process only.
 *
 * When team_name + name are both present on the Agent tool call,
 * the executor routes here. Registers the teammate in the team file
 * and SubAgentRegistry, then runs the agent loop as a background sub-agent.
 * Communication between teammates uses the file-based mailbox system.
 */

import { readdir } from 'node:fs/promises';

import type { ToolResult } from '../../tools/types.js';
import type { AgentDefinition, AgentSpawnContext } from '../../core/types.js';
import { loadTeamConfig, teamDir, listTeams } from '../../teams/team-store.js';
import { addMemberToTeam } from '../../utils/swarm/teamHelpers.js';
import type { SwarmTeamMember } from '../../utils/swarm/teamHelpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeammateSpawnInput {
  teamName: string;
  agentName: string;
  prompt: string;
  model?: string;
  background?: boolean;
  isolation?: 'worktree';
  agentSpawn: AgentSpawnContext;
  agentType: string;
  agentDef: AgentDefinition | null;
  cwd: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function isSwarmEnabled(): boolean {
  return process.env.CODERIX_EXPERIMENTAL_AGENT_TEAMS === '1' ||
    process.env.CODERIX_EXPERIMENTAL_AGENT_TEAMS === 'true';
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const TEAMMATE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA',
];

export async function spawnTeammate(
  input: TeammateSpawnInput,
): Promise<ToolResult> {
  const {
    teamName, agentName, prompt, model, agentType,
    agentSpawn,
  } = input;

  // ── Gate check ──────────────────────────────────────────────────────
  if (!isSwarmEnabled()) {
    return {
      content: [
        'Swarm teammates are experimental. To enable:',
        '  export CODERIX_EXPERIMENTAL_AGENT_TEAMS=1',
        '',
        'To spawn a standard sub-agent instead, omit team_name and use:',
        `  Agent(agent_type: "${agentType}", prompt: "...")`,
      ].join('\n'),
      isError: true,
    };
  }

  // ── Validate team exists ────────────────────────────────────────────
  const config = await loadTeamConfig(teamName);
  if (!config) {
    const dir = teamDir(teamName);
    let dirContents = '(directory does not exist)';
    try {
      const entries = await readdir(dir);
      dirContents = entries.length > 0 ? entries.join(', ') : '(empty directory)';
    } catch {
      // Directory doesn't exist
    }

    const teams = await listTeams();
    const available = teams.length > 0
      ? `\n\nAvailable teams: ${teams.join(', ')}`
      : '\n\nNo teams exist yet. Create one with TeamCreate.';

    return {
      content: [
        `Team '${teamName}' not found at ${dir}.`,
        `Directory contents: ${dirContents}${available}`,
        '',
        `Create it with: TeamCreate(name: "${teamName}", description: "...")`,
      ].join('\n'),
      isError: true,
    };
  }

  // ── Check duplicate ─────────────────────────────────────────────────
  const existing = config.members.find(m => m.name === agentName);
  if (existing && existing.status === 'running') {
    return {
      content: `Team member '${agentName}' is already running in team '${teamName}' (agentId: ${existing.agentId}). Use SendMessage to communicate with it.`,
      isError: true,
    };
  }

  // ── Generate identity ───────────────────────────────────────────────
  const agentId = `swarm-${shortId()}`;
  const colorIndex = Math.floor(Math.random() * TEAMMATE_COLORS.length);
  const color = TEAMMATE_COLORS[colorIndex];

  // ── Register in team file ───────────────────────────────────────────
  const member: SwarmTeamMember = {
    agentId,
    name: agentName,
    agentType: input.agentDef?.agentType ?? agentType,
    model,
    color,
    status: 'running',
    prompt,
    joinedAt: Date.now(),
  };

  await addMemberToTeam(teamName, member);

  // ── Register in SubAgentRegistry for TUI visibility ────────────────
  const subAbortController = new AbortController();
  agentSpawn.subAgentRegistry.register({
    id: agentId,
    name: `${agentName} (${teamName})`,
    agentType: agentType as 'explore' | 'plan' | 'general-purpose',
    status: 'running',
    prompt,
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController: subAbortController,
    notified: false,
  });

  // Fire-and-forget: run the agent as a background sub-agent.
  const { execute: agentExecute } = await import('./executor.js');
  const effectiveAgentType = input.agentDef?.agentType ?? agentType;

  agentExecute(
    {
      agent_type: effectiveAgentType,
      prompt,
      model,
      background: true,
      isolation: input.isolation,
      team_name: teamName,
      member_name: agentName,
    },
    {
      cwd: input.cwd,
      sessionId: input.sessionId,
      allowMutation: true,
      maxOutput: 200_000,
      bashTimeout: 120_000,
      agentSpawn,
      agentId,
    },
  ).catch((err) => {
    agentSpawn.subAgentRegistry.update(agentId, {
      status: 'error',
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    });
    agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
  });

  return {
    content: `Teammate '${agentName}' (${agentId}) spawned in team '${teamName}'. Use SendMessage to communicate with it.`,
    isError: false,
    metadata: {
      agentId,
      teamName,
      agentName,
      agentType,
    },
  };
}
