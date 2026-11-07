/**
 * turn-outcome.ts — why the last turn stopped, in one line.
 *
 * The chat panel shows this under the final message. Every engine reports a
 * `stop_reason` per model step, which is meaningless in isolation: a turn that
 * ran five tools reports `tool_use` four times before its real ending. So the
 * raw reason is only one input — the turn's actual ending (clean / stopped /
 * failed / cut off) is what the line explains, and the reason refines it.
 */

import type { TranslationKey } from './i18n/index.js';

/** How a turn ended, independent of why the model stopped generating. */
export type TurnEnding =
  | { kind: 'complete' }
  | { kind: 'interrupted' }
  | { kind: 'error'; message?: string }
  /** The stream ended without a terminal event — a provider cut the turn off. */
  | { kind: 'incomplete' }
  /** Still running, or nothing has finished yet. */
  | { kind: 'running' };

export interface TurnOutcomeInput {
  ending: TurnEnding;
  /** The last `stop_reason` the engine reported for the turn. */
  stopReason?: string;
  /** True while the turn is still streaming. */
  isStreaming?: boolean;
}

/**
 * A raw stop reason that is NOT a turn ending. `tool_use` means the model
 * handed control to a tool and the turn continues; reporting it as an ending
 * would claim the turn stopped while it is still working.
 */
function isIntermediateReason(stopReason: string): boolean {
  return stopReason === 'tool_use' || stopReason === 'tool_calls';
}

export type TurnOutcomeKind =
  | 'running'
  | 'complete'
  | 'max_tokens'
  | 'refusal'
  | 'paused'
  | 'interrupted'
  | 'timeout'
  | 'error'
  | 'incomplete';

export interface TurnOutcome {
  kind: TurnOutcomeKind;
  /** i18n key for the summary line. */
  messageKey: TranslationKey;
}

/**
 * Error codes the bridge sends in place of a model stop reason. They describe
 * *how* the turn died, so they answer the same question the line asks.
 */
function outcomeForErrorCode(code: string | undefined): TurnOutcome {
  switch (code) {
    case 'TURN_INCOMPLETE':
      return { kind: 'incomplete', messageKey: 'turn.incomplete' };
    case 'IDLE_TIMEOUT':
      return { kind: 'timeout', messageKey: 'turn.timeout' };
    case 'INTERRUPTED':
      return { kind: 'interrupted', messageKey: 'turn.interrupted' };
    default:
      return { kind: 'error', messageKey: 'turn.error' };
  }
}

/**
 * Collapse the turn's ending and its final stop reason into one explanation.
 *
 * Ordering matters: a terminal ending outranks the stop reason (a turn that
 * failed mid-stream has no meaningful `end_turn`), and a running turn outranks
 * everything (a step that just handed off to a tool has not ended anything).
 */
export function deriveTurnOutcome({ ending, stopReason, isStreaming }: TurnOutcomeInput): TurnOutcome {
  if (ending.kind === 'running' || isStreaming) {
    return { kind: 'running', messageKey: 'turn.running' };
  }

  if (ending.kind === 'error') {
    return outcomeForErrorCode(stopReason);
  }

  if (ending.kind === 'incomplete') {
    return { kind: 'incomplete', messageKey: 'turn.incomplete' };
  }

  if (ending.kind === 'interrupted') {
    return { kind: 'interrupted', messageKey: 'turn.interrupted' };
  }

  // A clean finish. The stop reason says *why* the model stopped generating,
  // which is what the user actually wonders about.
  switch (stopReason) {
    case 'max_tokens':
      return { kind: 'max_tokens', messageKey: 'turn.maxTokens' };
    case 'refusal':
      return { kind: 'refusal', messageKey: 'turn.refusal' };
    case 'pause_turn':
      return { kind: 'paused', messageKey: 'turn.paused' };
    default:
      // `tool_use` here would be a bug (see isIntermediateReason) — a completed
      // turn cannot still owe a tool result, so treat it as a normal ending.
      return { kind: 'complete', messageKey: 'turn.complete' };
  }
}

/** Whether a reported reason describes the turn's ending (vs. an in-flight step). */
export function isTerminalStopReason(stopReason: string | undefined): boolean {
  if (!stopReason) return false;
  return !isIntermediateReason(stopReason);
}