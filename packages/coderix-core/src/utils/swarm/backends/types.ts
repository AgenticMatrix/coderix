/**
 * Swarm backend interfaces — the two abstraction layers for teammate execution.
 *
 * Layer 1: PaneBackend — low-level terminal pane manipulation (tmux, iTerm2, etc.)
 * Layer 2: TeammateExecutor — high-level teammate lifecycle (spawn, message, kill)
 *
 * PaneBackendExecutor adapts Layer 1 → Layer 2.
 * InProcessBackend implements Layer 2 directly.
 */

// ---------------------------------------------------------------------------
// Layer 1: PaneBackend — terminal pane operations
// ---------------------------------------------------------------------------

export interface PaneCreateResult {
  paneId: string;
  windowTarget: string;
  insideCurrentSession: boolean;
}

export interface PaneBackend {
  readonly type: BackendType;

  /** Create a new pane for a teammate. Returns pane identifier info. */
  createTeammatePane(displayName: string, color?: string): Promise<PaneCreateResult>;

  /** Send a shell command to a specific pane. */
  sendCommandToPane(paneId: string, command: string): Promise<void>;

  /** Set the border color of a pane (for visual teammate identification). */
  setPaneBorderColor(paneId: string, color: string): Promise<void>;

  /** Set the pane title. */
  setPaneTitle(paneId: string, title: string): Promise<void>;

  /** Kill (close) a pane. */
  killPane(paneId: string): Promise<void>;

  /** Hide a pane from view (move to hidden session). */
  hidePane(paneId: string): Promise<boolean>;

  /** Show a previously hidden pane. */
  showPane(paneId: string, targetWindow: string): Promise<boolean>;

  /** Evenly rebalance pane sizes. */
  rebalancePanes(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backend type and metadata
// ---------------------------------------------------------------------------

export type BackendType = 'tmux' | 'iterm2' | 'windows-terminal' | 'in-process' | 'none';

export interface BackendInfo {
  type: BackendType;
  /** Human-readable label for display. */
  label: string;
  /** Whether this backend provides visual pane separation. */
  hasVisualPanes: boolean;
}

// ---------------------------------------------------------------------------
// Layer 2: TeammateExecutor — teammate lifecycle
// ---------------------------------------------------------------------------

export interface TeammateSpawnConfig {
  agentId: string;
  agentName: string;
  teamName: string;
  agentType: string;
  prompt: string;
  model?: string;
  color?: string;
  cwd: string;
  /** CLI args to forward to the spawned process. */
  cliArgs: string[];
  /** Environment variables for the spawned process. */
  env: Record<string, string>;
}

export interface TeammateSpawnResult {
  agentId: string;
  agentName: string;
  teamName: string;
  backend: BackendType;
}

export interface TeammateExecutor {
  readonly backend: BackendInfo;

  /** Spawn a new teammate (process or pane). */
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>;

  /** Send a message to a running teammate. */
  sendMessage(agentId: string, message: unknown): Promise<void>;

  /** Gracefully request the teammate to shut down. */
  terminate(agentId: string): Promise<void>;

  /** Force-kill a teammate (terminate process / kill pane). */
  kill(agentId: string): Promise<void>;

  /** Check if a teammate is still running. */
  isActive(agentId: string): Promise<boolean>;
}
