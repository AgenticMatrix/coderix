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

const text = (content: string): StreamBlock => ({ type: 'text', content, state: 'pending' });
const thinking = (content: string): StreamBlock => ({
  type: 'thinking',
  content,
  state: 'pending',
});

describe('deriveAgentStatus', () => {
  it('is idle when the turn is over and nothing is left running', () => {
    expect(
      deriveAgentStatus({
        isStreaming: false,
        currentMessage: null,
        messages: [assistant([{ type: 'text', content: 'done', state: 'done' }])],
      }),
    ).toBe('idle');
  });

  it('reports requesting before the first token arrives', () => {
    expect(
      deriveAgentStatus({ isStreaming: true, currentMessage: null, messages: [] }),
    ).toBe('requesting');
  });

  it('keeps requesting while the engine confirms the request is in flight', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: null,
        messages: [],
        requesting: true,
        previous: 'output',
      }),
    ).toBe('requesting');
  });

  it('leaves requesting as soon as a block is streaming', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [thinking('hm')] },
        messages: [],
        requesting: true,
      }),
    ).toBe('thinking');
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [text('partial')] },
        messages: [],
        requesting: true,
      }),
    ).toBe('output');
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
    // A turn that resumed after running in the background is back to requesting,
    // not stuck on the previous turn's badge.
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: null,
        messages: [],
        previous: 'background',
      }),
    ).toBe('requesting');
  });

  it('reports background when the answer landed but a task is still running', () => {
    expect(
      deriveAgentStatus({
        isStreaming: false,
        currentMessage: null,
        messages: [assistant([{ type: 'text', content: 'done', state: 'done' }])],
        runningTaskCount: 2,
      }),
    ).toBe('background');
  });

  it('falls back to idle once the last background task settles', () => {
    const base = {
      isStreaming: false,
      currentMessage: null,
      messages: [assistant([{ type: 'text', content: 'done', state: 'done' }])],
    };
    expect(deriveAgentStatus({ ...base, runningTaskCount: 1 })).toBe('background');
    expect(deriveAgentStatus({ ...base, runningTaskCount: 0 })).toBe('idle');
  });

  it('keeps the live turn badge while a background task also runs', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [text('again')] },
        messages: [],
        runningTaskCount: 1,
      }),
    ).toBe('output');
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

  it('reports error even when tools are still marked as running', () => {
    expect(
      deriveAgentStatus({
        isStreaming: false,
        currentMessage: null,
        messages: [assistant([toolUse('executing')])],
        runningTaskCount: 1,
        hasError: true,
      }),
    ).toBe('error');
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
