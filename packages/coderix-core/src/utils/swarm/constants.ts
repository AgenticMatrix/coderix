/**
 * Swarm constants — shared identifiers for team and swarm operations.
 */

/** tmux session name for external (non-tmux) leader processes. */
export const SWARM_SESSION_NAME = 'coderix-swarm';

/** Window name within the swarm session where teammates are displayed. */
export const SWARM_WINDOW_NAME = 'swarm-view';

/** Hidden session name for pane hiding (break-pane target). */
export const HIDDEN_SESSION_NAME = 'coderix-hidden';

/** Socket name suffix for tmux socket isolation (prevents polluting user's tmux). */
export const SWARM_SOCKET_NAME = 'coderix-swarm-socket';

/** Reserved name for the team leader / coordinator. */
export const TEAM_LEAD_NAME = 'lead';

/** Default polling interval for inbox messages (ms). */
export const INBOX_POLL_INTERVAL = 500;

/** Maximum mailbox messages before compaction. */
export const MAX_MAILBOX_MESSAGES = 500;

/** Teammate spawn — delay after pane creation for shell init (ms). */
export const PANE_INIT_DELAY = 200;

/** tmux command name. */
export const TMUX_COMMAND = 'tmux';

/** Environment variable for overriding the teammate spawn command. */
export const TEAMMATE_COMMAND_ENV_VAR = 'CODERIX_TEAMMATE_COMMAND';

/** Environment variable for teammate display color. */
export const TEAMMATE_COLOR_ENV_VAR = 'CODERIX_AGENT_COLOR';

/** Environment variable to force plan mode on teammates. */
export const PLAN_MODE_REQUIRED_ENV_VAR = 'CODERIX_PLAN_MODE_REQUIRED';

/** Generate a PID-isolated swarm socket name to prevent tmux conflicts. */
export function getSwarmSocketName(): string {
  return `coderix-swarm-socket-${process.pid}`;
}
