/**
 * Swarm teammate spawn — real backend dispatch (Phase 3).
 *
 * When team_name + name are both present on the Agent tool call,
 * the executor routes here. Selects a backend (tmux / iTerm2 / in-process),
 * spawns the teammate, registers it in the team file and SubAgentRegistry,
 * and returns a result to the caller.
 */

import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ToolResult } from '../../tools/types.js';
import type { AgentDefinition, AgentSpawnContext } from '../../core/types.js';
import { loadTeamConfig, teamDir, listTeams } from '../../teams/team-store.js';
import { getTeammateExecutor } from '../../utils/swarm/backends/registry.js';
import { buildTeammateCliArgs, buildForwardEnv } from '../../utils/swarm/spawnUtils.js';
import { addMemberToTeam } from '../../utils/swarm/teamHelpers.js';
import type { BackendType } from '../../utils/swarm/backends/types.js';

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

export interface TeammateSpawnResult {
  agentId: string;
  teamName: string;
  agentName: string;
  backend: BackendType;
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

  // ── Get executor ────────────────────────────────────────────────────
  const executor = getTeammateExecutor(agentSpawn);
  const backendType = executor.backend.type;

  // ── Build spawn config ──────────────────────────────────────────────
  const cliArgs = buildTeammateCliArgs({ agentId, agentName, teamName, agentColor: color, agentType, model });
  const env = buildForwardEnv({
    CODERIX_EXPERIMENTAL_AGENT_TEAMS: '1',
    CODERIX_AGENT_ID: agentId,
    CODERIX_AGENT_NAME: agentName,
    CODERIX_TEAM_NAME: teamName,
    CODERIX_AGENT_COLOR: color,
  });

  // ── Spawn via executor ──────────────────────────────────────────────
  try {
    const result = await executor.spawn({
      agentId,
      agentName,
      teamName,
      agentType: input.agentDef?.agentType ?? agentType,
      prompt,
      model,
      color,
      cwd: input.cwd,
      cliArgs,
      env,
    });

    // Register in SubAgentRegistry for TUI visibility
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

    const paneNote = backendType !== 'in-process'
      ? `\nThe teammate is running in a ${backendType} pane — switch to it to interact directly.`
      : '\nThe teammate is running in-process. Use SendMessage from team_name + to to communicate.';

    return {
      content: `Teammate '${agentName}' (${agentId}) spawned in team '${teamName}' via ${backendType} backend.${paneNote}`,
      isError: false,
      metadata: {
        agentId,
        teamName,
        agentName,
        agentType,
        backend: backendType,
      },
    };
  } catch (err) {
    return {
      content: `Failed to spawn teammate '${agentName}': ${(err as Error).message}`,
      isError: true,
    };
  }
}
