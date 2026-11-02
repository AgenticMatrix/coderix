import { describe, it, expect } from 'vitest';
import {
  deriveSessionListStatus,
  sessionListStatusFromAgentStatus,
} from '../session-status.js';

describe('deriveSessionListStatus', () => {
  it('is idle when nothing is in flight', () => {
    expect(deriveSessionListStatus({})).toBe('idle');
  });

  it('is busy while the turn is streaming', () => {
    expect(deriveSessionListStatus({ streaming: true })).toBe('busy');
  });

  it('is busy while a background task or compaction is running', () => {
    expect(deriveSessionListStatus({ runningTaskCount: 1 })).toBe('busy');
    expect(deriveSessionListStatus({ compacting: true })).toBe('busy');
    expect(deriveSessionListStatus({ requesting: true })).toBe('busy');
  });

  it('is busy when another client holds the session lease', () => {
    expect(deriveSessionListStatus({ leaseBusy: true })).toBe('busy');
  });

  it('prefers wait over any work in flight', () => {
    expect(
      deriveSessionListStatus({
        streaming: true,
        compacting: true,
        runningTaskCount: 2,
        leaseBusy: true,
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

  it('maps every in-flight phase to busy', () => {
    for (const status of ['requesting', 'thinking', 'executing', 'output', 'compacting', 'background'] as const) {
      expect(sessionListStatusFromAgentStatus(status)).toBe('busy');
    }
  });

  it('treats a settled error / interrupt as idle, not busy', () => {
    expect(sessionListStatusFromAgentStatus('error')).toBe('idle');
    expect(sessionListStatusFromAgentStatus('interrupted')).toBe('idle');
  });
});
