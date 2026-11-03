import { describe, it, expect } from 'vitest';
import { countSessionRunningAgents, deriveAgentStatus } from '../agent-status.js';
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

  it('reports compacting while the turn summarises itself', () => {
    // Compaction emits no blocks, so without the flag the badge would read
    // "sending request" for however long the summary takes.
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: null,
        messages: [],
        compacting: true,
      }),
    ).toBe('compacting');
  });

  it('lets compacting outrank in-flight work but not a failure', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [toolUse('executing')] },
        messages: [],
        compacting: true,
      }),
    ).toBe('compacting');
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: null,
        messages: [],
        compacting: true,
        hasError: true,
      }),
    ).toBe('error');
  });

  it('returns to the live badge once compaction settles', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [text('resumed')] },
        messages: [],
        compacting: false,
      }),
    ).toBe('output');
  });

  it('reports interrupted after the user stops a turn', () => {
    expect(
      deriveAgentStatus({
        isStreaming: false,
        currentMessage: null,
        messages: [assistant([{ type: 'text', content: 'half', state: 'done' }])],
        interrupted: true,
      }),
    ).toBe('interrupted');
  });

  it('drops the interrupted badge while a new turn streams', () => {
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [text('next')] },
        messages: [],
        interrupted: true,
      }),
    ).toBe('output');
  });

  it('counts a background sub-agent as background, not idle', () => {
    const base = {
      isStreaming: false,
      currentMessage: null,
      messages: [assistant([{ type: 'text', content: 'done', state: 'done' }])],
    };
    expect(deriveAgentStatus({ ...base, runningAgentCount: 1 })).toBe('background');
    expect(deriveAgentStatus({ ...base, runningAgentCount: 0 })).toBe('idle');
  });

  it('does not call a tool or system block "thinking"', () => {
    const toolResult: StreamBlock = { type: 'tool_result', content: 'ok', state: 'done' };
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [toolResult] },
        messages: [],
        previous: 'output',
      }),
    ).toBe('output');
    expect(
      deriveAgentStatus({
        isStreaming: true,
        currentMessage: { blocks: [toolResult] },
        messages: [],
        previous: 'idle',
      }),
    ).toBe('requesting');
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

describe('countSessionRunningAgents', () => {
  it('counts only agents spawned by a tool call in this conversation', () => {
    const agents = {
      'toolu_own': { status: 'running' },
      'toolu_other': { status: 'running' },
      'toolu_done': { status: 'done' },
    };
    expect(countSessionRunningAgents(agents, new Set(['toolu_own', 'toolu_done']))).toBe(1);
  });

  it('matches a record by its toolUseId when the map key is an engine id', () => {
    const agents = {
      'sub-a1b2': { status: 'running', toolUseId: 'toolu_own' },
    };
    expect(countSessionRunningAgents(agents, new Set(['toolu_own']))).toBe(1);
  });

  it('is zero when the transcript has no spawning tool call', () => {
    expect(
      countSessionRunningAgents({ 'toolu_other': { status: 'running' } }, new Set()),
    ).toBe(0);
  });
});
