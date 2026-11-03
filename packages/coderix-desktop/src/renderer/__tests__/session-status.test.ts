import { describe, it, expect } from 'vitest';
import {
  deriveSessionListStatus,
  sessionListStatusFromAgentStatus,
} from '../session-status.js';

describe('deriveSessionListStatus', () => {
  it('is idle when nothing is in flight', () => {
    expect(deriveSessionListStatus({})).toBe('idle');
  });

  it('is busy while the turn is streaming or compacting', () => {
    expect(deriveSessionListStatus({ streaming: true })).toBe('busy');
    expect(deriveSessionListStatus({ compacting: true })).toBe('busy');
  });

  it('reads as waiting — not busy — once only background work is left', () => {
    // The turn is over and the user can type; a red "busy" badge would claim
    // the conversation is occupied when it is only waiting for tasks to drain.
    expect(deriveSessionListStatus({ runningTaskCount: 1 })).toBe('background');
    // A live turn still outranks background work that started during it.
    expect(deriveSessionListStatus({ streaming: true, runningTaskCount: 1 })).toBe('busy');
  });

  it('keeps terminal outcomes distinct so the row matches the bar', () => {
    expect(deriveSessionListStatus({ hasError: true })).toBe('error');
    expect(deriveSessionListStatus({ interrupted: true })).toBe('interrupted');
    // The bar ranks a failure above everything while it is still showing.
    expect(deriveSessionListStatus({ hasError: true, streaming: true })).toBe('error');
    // Compaction outranks a blocked prompt, like deriveAgentStatus.
    expect(deriveSessionListStatus({ compacting: true, awaitingUser: true })).toBe('busy');
    // An interrupt outranks the background work still draining behind it.
    expect(deriveSessionListStatus({ interrupted: true, runningTaskCount: 1 })).toBe(
      'interrupted',
    );
  });

  it('ignores a settled request-start — the bar requires a live turn', () => {
    // `requesting` is not an input at all: the bar only uses it while
    // isStreaming is true, so it can never make a settled row busy.
    expect(
      // @ts-expect-error requesting is deliberately not part of the input.
      deriveSessionListStatus({ requesting: true }),
    ).toBe('idle');
  });

  it('ignores a write lease — ownership is not activity', () => {
    // A live CLI holds the lease even while idle at its prompt; the badge must
    // stay idle so it agrees with the status bar, which cannot see the lease.
    expect(
      // @ts-expect-error leaseBusy is deliberately not part of the input.
      deriveSessionListStatus({ leaseBusy: true }),
    ).toBe('idle');
  });

  it('prefers wait over work in flight', () => {
    expect(
      deriveSessionListStatus({
        streaming: true,
        runningTaskCount: 2,
        awaitingUser: true,
      }),
    ).toBe('wait');
  });
});

describe('sessionListStatusFromAgentStatus', () => {
  it('maps only a genuinely idle bar to the green idle badge', () => {
    expect(sessionListStatusFromAgentStatus('idle')).toBe('idle');
  });

  it('maps the bar’s waiting phase to wait', () => {
    expect(sessionListStatusFromAgentStatus('waiting')).toBe('wait');
  });

  it('maps every live turn phase to busy', () => {
    for (const status of ['requesting', 'thinking', 'executing', 'output', 'compacting'] as const) {
      expect(sessionListStatusFromAgentStatus(status)).toBe('busy');
    }
  });

  it('maps the bar’s background phase to waiting, not busy', () => {
    // The turn has landed; only background tasks are running. The row shows
    // 等待 (yellow) just like it does for the bar's other waiting phase.
    expect(sessionListStatusFromAgentStatus('background')).toBe('background');
  });

  it('keeps a settled error / interrupt as its own state, like the bar', () => {
    expect(sessionListStatusFromAgentStatus('error')).toBe('error');
    expect(sessionListStatusFromAgentStatus('interrupted')).toBe('interrupted');
  });
});
