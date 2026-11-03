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
import { deriveAgentStatus, type AgentStatus, type AgentStatusInput } from './agent-status.js';

export type SessionListStatus =
  | 'busy'
  | 'wait'
  | 'background'
  | 'idle'
  | 'error'
  | 'interrupted';

// A session lease is deliberately NOT an input anywhere here. It marks write
// ownership, not activity: an interactive CLI holds it for its whole process
// lifetime, even while sitting idle at the prompt. Painting "busy" from it made
// the row pulse forever while the status bar — which cannot see another client's
// lease — read idle. The lease still gates writes (submit copies the session
// instead of appending); it just doesn't describe what is running.
//
// Every row — viewed or backgrounded — runs through the *same* derivation as the
// bottom status bar, then collapses the phase onto the row's coarse badge. The
// callers feed it from the per-session maps (see SessionList), so a session
// cannot change badge merely because the user clicked away from it. In
// particular `requesting` is safe here: the bar only uses it while the turn is
// streaming, so it can never make a settled session busy.
export function deriveSessionRowStatus(input: AgentStatusInput): SessionListStatus {
  return sessionListStatusFromAgentStatus(deriveAgentStatus(input));
}

/**
 * Project the bar's phase onto the row badge. Every live turn phase collapses
 * to `busy`; background draining reads as `background` (等待) and terminal
 * outcomes keep their own states.
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