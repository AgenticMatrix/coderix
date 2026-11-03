/**
 * Collapse a conversation's live signals into the states shown in the sidebar
 * list. The list has one badge per row, so every in-flight phase has to read as
 * `busy` — the detailed phase belongs to the status bar of the session being
 * viewed. Terminal outcomes keep their own state (`error` / `interrupted`) so
 * the row never disagrees with the bar when a turn fails or is stopped.
 *
 * `background` is its own state: the turn is over and the user can type, but
 * background tasks/sub-agents are still finishing. That is "waiting for work to
 * drain", not "the conversation is running", so the row reads 等待 rather than
 * the red 忙碌 badge.
 */
import type { AgentStatus } from './agent-status.js';

export type SessionListStatus =
  | 'busy'
  | 'wait'
  | 'background'
  | 'idle'
  | 'error'
  | 'interrupted';

export interface SessionListStatusInput {
  /** The session's turn is in flight (flat state for the viewed session, map slot otherwise). */
  streaming?: boolean;
  /** A permission or AskUserQuestion prompt is blocking this session. */
  awaitingUser?: boolean;
  /** Context compaction is running for this session. */
  compacting?: boolean;
  /** Background tasks still running for this session. */
  runningTaskCount?: number;
  /** The last turn failed. */
  hasError?: boolean;
  /** The user stopped the last turn and nothing has started since. */
  interrupted?: boolean;
}

// A session lease is deliberately NOT an input here. It marks write ownership,
// not activity: an interactive CLI holds it for its whole process lifetime,
// even while sitting idle at the prompt. Painting "busy" from it made the row
// pulse forever while the status bar — which cannot see another client's
// lease — read idle. The lease still gates writes (submit copies the session
// instead of appending); it just doesn't describe what is running.
//
// `requesting` is not an input either: the bar only lets it refine a phase
// while the turn is streaming (`isStreaming` gates it), so it can never make a
// settled session busy. The `streaming` flag already spans the whole turn.
export function deriveSessionListStatus({
  streaming = false,
  awaitingUser = false,
  compacting = false,
  runningTaskCount = 0,
  hasError = false,
  interrupted = false,
}: SessionListStatusInput): SessionListStatus {
  // Same precedence as deriveAgentStatus: a failure outranks everything, then
  // compaction (it blocks the turn), then the only state that needs the user,
  // then the turn itself. An interrupt is "what just happened", so it outranks
  // the background work still draining behind it.
  if (hasError) return 'error';
  if (compacting) return 'busy';
  if (awaitingUser) return 'wait';
  if (streaming) return 'busy';
  if (interrupted) return 'interrupted';
  // The turn is over; only background work is left. The user can type, so this
  // is waiting, not busy.
  if (runningTaskCount > 0) return 'background';
  return 'idle';
}

/**
 * Project the bottom status bar's phase onto the row badge. The two must never
 * disagree for the conversation being viewed: the bar is the single source of
 * truth for that session (it alone knows about the gap between model steps,
 * compaction and background work), so the row mirrors it instead of
 * re-deriving from the raw per-session maps. Every live turn phase collapses
 * to the row's `busy`; background draining reads as `background` (等待) and
 * terminal outcomes are kept as their own states.
 */
export function sessionListStatusFromAgentStatus(status: AgentStatus): SessionListStatus {
  switch (status) {
    case 'waiting':
      return 'wait';
    case 'background':
      return 'background';
    case 'idle':
      return 'idle';
    case 'error':
      return 'error';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'busy';
  }
}
