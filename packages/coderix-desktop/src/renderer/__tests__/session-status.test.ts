import { describe, it, expect } from 'vitest';
import {
  deriveSessionRowStatus,
  sessionListStatusFromAgentStatus,
} from '../session-status.js';
import type { AgentStatusInput } from '../agent-status.js';
import type { ChatMessage } from '../store/types.js';
import type { StreamBlock } from '../types.js';

function toolUse(state: StreamBlock['state']): StreamBlock {
  return { type: 'tool_use', toolId: 't1', toolName: 'Bash', state };
}

function assistant(blocks: StreamBlock[]): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '', blocks, timestamp: 1 };
}

const text = (content: string): StreamBlock => ({ type: 'text', content, state: 'done' });

const base: AgentStatusInput = {
  isStreaming: false,
  currentMessage: null,
  messages: [assistant([text('done')])],
};

describe('deriveSessionRowStatus', () => {
  it('is idle when the turn is over and nothing is running', () => {
    expect(deriveSessionRowStatus(base)).toBe('idle');
  });

  it('collapses every live phase to busy', () => {
    expect(deriveSessionRowStatus({ ...base, isStreaming: true, currentMessage: { blocks: [text('x')] } })).toBe('busy');
    expect(deriveSessionRowStatus({ ...base, requesting: true, isStreaming: true })).toBe('busy');
    expect(deriveSessionRowStatus({ ...base, compacting: true })).toBe('busy');
  });

  it('stays busy while a tool executes, even with the turn flag already down', () => {
    // The same check the bar uses: a committed in-flight tool outranks the turn
    // flag, so clicking away cannot downgrade the badge to 等待.
    expect(
      deriveSessionRowStatus({
        ...base,
        messages: [assistant([toolUse('executing')])],
      }),
    ).toBe('busy');
    expect(
      deriveSessionRowStatus({
        ...base,
        currentMessage: { blocks: [toolUse('pending')] },
      }),
    ).toBe('busy');
  });

  it('reads background work — and only background work — as waiting', () => {
    expect(deriveSessionRowStatus({ ...base, runningTaskCount: 1 })).toBe('background');
    expect(deriveSessionRowStatus({ ...base, runningAgentCount: 1 })).toBe('background');
    // A live turn still outranks background work that started during it.
    expect(
      deriveSessionRowStatus({ ...base, isStreaming: true, runningTaskCount: 1 }),
    ).toBe('busy');
  });

  it('keeps waiting and terminal outcomes distinct', () => {
    expect(deriveSessionRowStatus({ ...base, awaitingUser: true })).toBe('wait');
    expect(deriveSessionRowStatus({ ...base, hasError: true })).toBe('error');
    expect(deriveSessionRowStatus({ ...base, interrupted: true })).toBe('interrupted');
    // A failure outranks everything; compaction outranks a blocked prompt.
    expect(deriveSessionRowStatus({ ...base, hasError: true, isStreaming: true })).toBe('error');
    expect(deriveSessionRowStatus({ ...base, compacting: true, awaitingUser: true })).toBe('busy');
    expect(
      deriveSessionRowStatus({ ...base, interrupted: true, runningTaskCount: 1 }),
    ).toBe('interrupted');
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