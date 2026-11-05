import { describe, expect, it } from 'vitest';
import { deriveTurnOutcome, isTerminalStopReason } from '../turn-outcome.js';

describe('deriveTurnOutcome', () => {
  it('says nothing conclusive while the turn is still running', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'running' }, stopReason: 'tool_use' });
    expect(outcome.kind).toBe('running');
    expect(outcome.messageKey).toBe('turn.running');
  });

  it('does not report a stop for a step that merely handed off to a tool', () => {
    // `tool_use` is reported before every tool step, so a live turn must win.
    const outcome = deriveTurnOutcome({ ending: { kind: 'running' }, stopReason: 'tool_use', isStreaming: true });
    expect(outcome.kind).toBe('running');
  });

  it('reports a normal completion for a clean end_turn', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'complete' }, stopReason: 'end_turn' });
    expect(outcome.kind).toBe('complete');
    expect(outcome.messageKey).toBe('turn.complete');
  });

  it('explains a turn cut off at the output limit', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'complete' }, stopReason: 'max_tokens' });
    expect(outcome.kind).toBe('max_tokens');
    expect(outcome.messageKey).toBe('turn.maxTokens');
  });

  it('explains a model refusal', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'complete' }, stopReason: 'refusal' });
    expect(outcome.kind).toBe('refusal');
    expect(outcome.messageKey).toBe('turn.refusal');
  });

  it('explains a paused turn', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'complete' }, stopReason: 'pause_turn' });
    expect(outcome.kind).toBe('paused');
    expect(outcome.messageKey).toBe('turn.paused');
  });

  it('reports a user stop as interrupted, not as a failure', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'interrupted' } });
    expect(outcome.kind).toBe('interrupted');
    expect(outcome.messageKey).toBe('turn.interrupted');
  });

  it('surfaces a cut-off stream as incomplete rather than a clean finish', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'error' }, stopReason: 'TURN_INCOMPLETE' });
    expect(outcome.kind).toBe('incomplete');
    expect(outcome.messageKey).toBe('turn.incomplete');
  });

  it('distinguishes an idle timeout from a generic failure', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'error' }, stopReason: 'IDLE_TIMEOUT' });
    expect(outcome.kind).toBe('timeout');
    expect(outcome.messageKey).toBe('turn.timeout');
  });

  it('falls back to a generic failure for an unknown error', () => {
    const outcome = deriveTurnOutcome({ ending: { kind: 'error' }, stopReason: 'RUNTIME' });
    expect(outcome.kind).toBe('error');
    expect(outcome.messageKey).toBe('turn.error');
  });

  it('lets a failure outrank a stale stop reason from an earlier step', () => {
    // The turn errored after a tool step reported `tool_use`; the error is the
    // real ending and must not be described as a normal completion.
    const outcome = deriveTurnOutcome({ ending: { kind: 'error' }, stopReason: 'tool_use' });
    expect(outcome.kind).toBe('error');
  });
});

describe('isTerminalStopReason', () => {
  it('treats tool_use as an in-flight step, not an ending', () => {
    expect(isTerminalStopReason('tool_use')).toBe(false);
    expect(isTerminalStopReason('tool_calls')).toBe(false);
  });

  it('treats real endings as terminal', () => {
    expect(isTerminalStopReason('end_turn')).toBe(true);
    expect(isTerminalStopReason('max_tokens')).toBe(true);
  });

  it('treats a missing reason as unknown', () => {
    expect(isTerminalStopReason(undefined)).toBe(false);
  });
});