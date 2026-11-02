/**
 * Collapse a conversation's live signals into the three states shown in the
 * sidebar list. The list has one badge per row, so anything in flight has to
 * read as `busy` — the detailed phase belongs to the status bar of the session
 * being viewed.
 */
import type { AgentStatus } from './agent-status.js';

export type SessionListStatus = 'busy' | 'wait' | 'idle';

export interface SessionListStatusInput {
  /** The session's turn is in flight (flat state for the viewed session, map slot otherwise). */
  streaming?: boolean;
  /** A permission or AskUserQuestion prompt is blocking this session. */
  awaitingUser?: boolean;
  /** Context compaction is running for this session. */
  compacting?: boolean;
  /** A model request is out but no token has come back yet. */
  requesting?: boolean;
  /** Background tasks still running for this session. */
  runningTaskCount?: number;
  /** Another live client (the CLI) owns this session's write lease. */
  leaseBusy?: boolean;
}

export function deriveSessionListStatus({
  streaming = false,
  awaitingUser = false,
  compacting = false,
  requesting = false,
  runningTaskCount = 0,
  leaseBusy = false,
}: SessionListStatusInput): SessionListStatus {
  // The only state that needs the user. It outranks work in flight because the
  // conversation cannot move until the prompt is answered.
  if (awaitingUser) return 'wait';
  if (streaming || compacting || requesting || runningTaskCount > 0 || leaseBusy) {
    return 'busy';
  }
  return 'idle';
}

/**
 * Project the bottom status bar's phase onto the row badge. The two must never
 * disagree for the conversation being viewed: the bar is the single source of
 * truth for that session (it alone knows about the gap between model steps,
 * compaction and background work), so the row mirrors it instead of
 * re-deriving from the raw per-session maps.
 *
 * `error` and `interrupted` are outcomes, not liveness: nothing is running, so
 * the row reads `idle`. Only in-flight work is `busy` — otherwise a failed or
 * stopped turn would keep the row pulsing forever.
 */
export function sessionListStatusFromAgentStatus(status: AgentStatus): SessionListStatus {
  switch (status) {
    case 'waiting':
      return 'wait';
    case 'idle':
    case 'interrupted':
    case 'error':
      return 'idle';
    default:
      return 'busy';
  }
}
