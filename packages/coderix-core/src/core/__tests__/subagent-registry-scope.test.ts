import { describe, it, expect } from 'vitest';
import { SubAgentRegistry } from '../subagent-registry.js';
import type { SubAgentRecord } from '../subagent-registry.js';

/**
 * The registry is process-wide: concurrent conversations share it. Stopping one
 * conversation therefore has to scope the abort, or it kills another session's
 * running agents.
 */

function record(
  id: string,
  sessionId: string | undefined,
  status: SubAgentRecord['status'] = 'running',
): SubAgentRecord {
  return {
    id,
    name: id,
    agentType: 'general-purpose',
    status,
    prompt: 'do work',
    createdAt: Date.now(),
    turnCount: 0,
    messageCount: 0,
    toolCount: 0,
    abortController: new AbortController(),
    notified: false,
    sessionId,
  };
}

describe('SubAgentRegistry.abortAllInSession', () => {
  it('aborts only the running agents of the named conversation', () => {
    const registry = new SubAgentRegistry();
    const mine = record('mine', 's1');
    const mineDone = record('mine-done', 's1', 'done');
    const theirs = record('theirs', 's2');
    const unattributed = record('unattributed', undefined);
    for (const r of [mine, mineDone, theirs, unattributed]) registry.register(r);

    const aborted = registry.abortAllInSession('s1');

    expect(aborted).toBe(1);
    expect(mine.abortController.signal.aborted).toBe(true);
    expect(mineDone.abortController.signal.aborted).toBe(false);
    expect(theirs.abortController.signal.aborted).toBe(false);
    expect(unattributed.abortController.signal.aborted).toBe(false);
  });

  it('reports zero when the conversation has nothing running', () => {
    const registry = new SubAgentRegistry();
    registry.register(record('theirs', 's2'));

    expect(registry.abortAllInSession('s1')).toBe(0);
  });
});