/**
 * PaneBackendExecutor — adapts a PaneBackend to the TeammateExecutor interface.
 *
 * This is the key bridge between the low-level pane operations (tmux, iTerm2)
 * and the high-level teammate lifecycle. Each spawned teammate gets:
 *   1. A new pane created via the PaneBackend
 *   2. A shell command sent to that pane (launches Coderix with teammate identity)
 *   3. An initial prompt written to the teammate's mailbox
 */

import type { PaneBackend, PaneCreateResult } from './types.js';
import type { TeammateExecutor, TeammateSpawnConfig, TeammateSpawnResult, BackendType, BackendInfo } from './types.js';
import { addMemberToTeam, updateMemberInTeam, type SwarmTeamMember } from '../teamHelpers.js';
import { writeToMailbox, clearMailbox } from '../teammateMailbox.js';
import { getBinaryPath, buildForwardEnv, buildTeammateCliArgs } from '../spawnUtils.js';
import { PANE_INIT_DELAY } from '../constants.js';

// Per-pane tracking
interface PaneTeammate {
  paneId: string;
  windowTarget: string;
  insideCurrentSession: boolean;
  agentName: string;
  teamName: string;
}

export class PaneBackendExecutor implements TeammateExecutor {
  readonly backend: BackendInfo;

  private spawnedTeammates = new Map<string, PaneTeammate>();

  constructor(private paneBackend: PaneBackend) {
    this.backend = {
      type: paneBackend.type,
      label: paneBackend.type === 'tmux' ? 'Tmux' : 'iTerm2',
      hasVisualPanes: true,
    };
  }

  // -----------------------------------------------------------------------
  // TeammateExecutor implementation
  // -----------------------------------------------------------------------

  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    // 1. Create the terminal pane
    const result: PaneCreateResult = await this.paneBackend.createTeammatePane(
      config.agentName,
      config.color,
    );

    this.spawnedTeammates.set(config.agentId, {
      paneId: result.paneId,
      windowTarget: result.windowTarget,
      insideCurrentSession: result.insideCurrentSession,
      agentName: config.agentName,
      teamName: config.teamName,
    });

    // 2. Build the spawn command
    const binaryPath = getBinaryPath();
    const cliArgs = buildTeammateCliArgs({
      agentId: config.agentId,
      agentName: config.agentName,
      teamName: config.teamName,
      agentColor: config.color,
      agentType: config.agentType,
      model: config.model,
    });

    // Add forwarded env vars
    const env = buildForwardEnv({
      CODERIX_EXPERIMENTAL_AGENT_TEAMS: '1',
      CODERIX_TEAMMATE_MODE: this.backend.type,
      CODERIX_AGENT_ID: config.agentId,
      CODERIX_AGENT_NAME: config.agentName,
      CODERIX_TEAM_NAME: config.teamName,
    });

    const envString = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');

    const command = `${envString} ${binaryPath} ${cliArgs.join(' ')}`;

    // 3. Wait for shell init, then send command
    await sleep(PANE_INIT_DELAY);
    await this.paneBackend.sendCommandToPane(result.paneId, command);

    // 4. Register in team file
    const member: SwarmTeamMember = {
      agentId: config.agentId,
      name: config.agentName,
      agentType: config.agentType,
      model: config.model,
      color: config.color,
      status: 'running',
      prompt: config.prompt,
      backendType: this.backend.type,
      paneId: result.paneId,
      joinedAt: Date.now(),
    };

    await addMemberToTeam(config.teamName, member);

    // 5. Send initial prompt to teammate's mailbox
    await writeToMailbox(config.agentName, {
      from: 'lead',
      text: config.prompt,
      timestamp: new Date().toISOString(),
      summary: config.prompt.slice(0, 80),
    }, config.teamName);

    // 6. Register cleanup on process exit
    this.registerCleanup(config.agentId);

    return {
      agentId: config.agentId,
      agentName: config.agentName,
      teamName: config.teamName,
      backend: this.backend.type,
    };
  }

  async sendMessage(agentId: string, message: string): Promise<void> {
    const tm8 = this.spawnedTeammates.get(agentId);
    if (!tm8) return;

    await writeToMailbox(tm8.agentName, {
      from: 'lead',
      text: message,
      timestamp: new Date().toISOString(),
    }, tm8.teamName);
  }

  async terminate(agentId: string): Promise<void> {
    const tm8 = this.spawnedTeammates.get(agentId);
    if (!tm8) return;

    await writeToMailbox(tm8.agentName, {
      from: 'lead',
      text: JSON.stringify({ type: 'shutdown_request' }),
      timestamp: new Date().toISOString(),
    }, tm8.teamName);
  }

  async kill(agentId: string): Promise<void> {
    const tm8 = this.spawnedTeammates.get(agentId);
    if (!tm8) return;

    // Kill the pane
    await this.paneBackend.killPane(tm8.paneId);
    this.spawnedTeammates.delete(agentId);
    this.cleanupHandlers.delete(agentId);
  }

  async isActive(agentId: string): Promise<boolean> {
    return this.spawnedTeammates.has(agentId);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  private cleanupHandlers = new Map<string, () => void>();

  private registerCleanup(agentId: string): void {
    if (this.cleanupHandlers.has(agentId)) return;

    const handler = () => {
      const tm8 = this.spawnedTeammates.get(agentId);
      if (tm8) {
        this.paneBackend.killPane(tm8.paneId).catch(() => {});
      }
    };

    this.cleanupHandlers.set(agentId, handler);

    // Kill all panes on process exit
    if (this.cleanupHandlers.size === 1) {
      process.once('exit', () => {
        for (const h of this.cleanupHandlers.values()) h();
      });
      if (process.platform !== 'win32') {
        process.once('SIGHUP', () => {
          for (const h of this.cleanupHandlers.values()) h();
          process.exit(0);
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
