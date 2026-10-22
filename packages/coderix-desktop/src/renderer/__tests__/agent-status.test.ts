import { describe, it, expect } from 'vitest';
import { deriveAgentStatus } from '../agent-status.js';
import type { ChatMessage } from '../store/types.js';
import type { StreamBlock } from '../types.js';

function toolUse(state: StreamBlock['state']): StreamBlock {
  return { type: 'tool_use', toolId: 't1', toolName: 'Bash', state };
}

function assistant(blocks: StreamBlock[]): ChatMessage {
  return { id: 'a1', role: 'assistant', content: '', blocks, timestamp: 1 };
}

describe('deriveAgentStatus', () => {
  it('is idle when the turn is over', () => {
    expect(
      deriveAgentStatus({
        isStreaming: false,
        currentMessage: null,
        messages: [assistant([{ type: 'text', content: 'done', state: 'done' }])],
      }),
    ).toBe('idle');
  });

  it('is thinking while the first tokens have not arrived', () => {
    expect(
      deriveAgentStatus({ isStreaming: true, currentMessage: null, messages: [] }),
    ).toBe('thinking');
  });

  it('reports executing for a tool in flight', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [toolUse('executing')] },
        messages: [],
      }),
    ).toBe('executing');
  });

  it('reports executing for a committed tool whose step already ended', () => {
    // message_stop commits the step and clears the in-flight message *before*
    // the tool runs, so the only evidence is the committed transcript.
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: null,
        messages: [assistant([toolUse('executing')])],
        previous: 'output',
      }),
    ).toBe('executing');
  });

  it('reports output while assistant text is streaming', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [{ type: 'text', content: 'partial', state: 'pending' }] },
        messages: [],
      }),
    ).toBe('output');
  });

  it('never falls back to idle between model steps of a live turn', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: null,
        messages: [assistant([{ type: 'text', content: 'answer', state: 'done' }])],
        previous: 'output',
      }),
    ).toBe('output');
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [] },
        messages: [],
        previous: 'executing',
      }),
    ).toBe('executing');
  });

  it('reports waiting while a permission or question prompt is open', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [toolUse('pending')] },
        messages: [],
        awaitingUser: true,
      }),
    ).toBe('waiting');
  });

  it('ignores a tool that already finished or errored', () => {
    expect(
      deriveAgentStatus({
        isStreaming: false,
        currentMessage: null,
        messages: [assistant([toolUse('done'), toolUse('error')])],
      }),
    ).toBe('idle');
  });
});
