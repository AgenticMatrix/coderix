import { describe, it, expect } from 'vitest';
import {
  deriveAgentPhase,
  statusPhaseOf,
  agentPhaseLabel,
  type AgentPhaseInput,
} from '../agent-phase.js';
import type { Message, ToolUseState } from '../../types.js';

function assistantWithTools(...states: ToolUseState[]): Message {
  return {
    id: 1,
    role: 'assistant',
    content: '',
    blocks: states.map((state, i) => ({
      type: 'tool_use' as const,
      toolName: 'bash',
      toolId: `t${i}`,
      input: {},
      state,
    })),
    timestamp: 1,
  };
}

function base(overrides: Partial<AgentPhaseInput> = {}): AgentPhaseInput {
  return {
    error: null,
    isCompacting: false,
    isStreaming: false,
    thinkingInProgress: false,
    turnStatus: 'idle',
    turnAlive: true,
    lastMessage: undefined,
    runningForegroundAgents: 0,
    runningBackgroundAgents: 0,
    runningBackgroundTasks: 0,
    ...overrides,
  };
}

describe('deriveAgentPhase', () => {
  it('is idle when the turn is over and nothing else runs', () => {
    expect(deriveAgentPhase(base())).toBe('idle');
  });

  it('separates streaming from thinking', () => {
    expect(deriveAgentPhase(base({ isStreaming: true }))).toBe('busy.streaming');
    expect(deriveAgentPhase(base({ isStreaming: true, thinkingInProgress: true }))).toBe(
      'busy.thinking',
    );
  });

  it('is busy while compacting', () => {
    expect(deriveAgentPhase(base({ isCompacting: true }))).toBe('busy.compacting');
  });

  it('is busy.executing for a tool that started producing', () => {
    expect(deriveAgentPhase(base({ lastMessage: assistantWithTools('executing') }))).toBe(
      'busy.executing',
    );
  });

  it('is busy.executing while a foreground sub-agent runs', () => {
    expect(deriveAgentPhase(base({ runningForegroundAgents: 2 }))).toBe('busy.executing');
  });

  it('is wait.tool for a call that has not started producing', () => {
    expect(deriveAgentPhase(base({ lastMessage: assistantWithTools('pending') }))).toBe(
      'wait.tool',
    );
  });

  it('treats an executing tool as busy even when another call is still pending', () => {
    expect(
      deriveAgentPhase(base({ lastMessage: assistantWithTools('pending', 'executing') })),
    ).toBe('busy.executing');
  });

  it('is wait.llm while the turn is live but nothing is arriving', () => {
    expect(deriveAgentPhase(base({ turnStatus: 'running' }))).toBe('wait.llm');
  });

  it('is wait.background when a task outlived the turn', () => {
    expect(deriveAgentPhase(base({ runningBackgroundTasks: 1 }))).toBe('wait.background');
    expect(deriveAgentPhase(base({ runningBackgroundAgents: 1 }))).toBe('wait.background');
  });

  it('prefers the live LLM wait over background work during a turn', () => {
    expect(
      deriveAgentPhase(base({ turnStatus: 'running', runningBackgroundTasks: 3 })),
    ).toBe('wait.llm');
  });

  it('does not wait forever on a dead turn', () => {
    expect(deriveAgentPhase(base({ turnStatus: 'running', turnAlive: false }))).toBe('idle');
    expect(
      deriveAgentPhase(
        base({ turnStatus: 'running', turnAlive: false, runningBackgroundTasks: 1 }),
      ),
    ).toBe('wait.background');
  });

  it('hides a failed turn behind its error', () => {
    expect(
      deriveAgentPhase(
        base({ error: 'boom', isStreaming: true, lastMessage: assistantWithTools('executing') }),
      ),
    ).toBe('idle');
  });

  it('ignores finished tools', () => {
    expect(deriveAgentPhase(base({ lastMessage: assistantWithTools('done', 'error') }))).toBe(
      'idle',
    );
  });
});

describe('phase helpers', () => {
  it('collapses to the coarse phase the bar colors by', () => {
    expect(statusPhaseOf('idle')).toBe('idle');
    expect(statusPhaseOf('busy.streaming')).toBe('busy');
    expect(statusPhaseOf('busy.executing')).toBe('busy');
    expect(statusPhaseOf('wait.tool')).toBe('wait');
    expect(statusPhaseOf('wait.background')).toBe('wait');
  });

  it('labels every non-idle phase for the activity line', () => {
    expect(agentPhaseLabel('idle')).toBeNull();
    expect(agentPhaseLabel('busy.thinking')).toBe('Thinking');
    expect(agentPhaseLabel('busy.executing')).toBe('Executing');
    expect(agentPhaseLabel('busy.streaming')).toBe('Streaming');
    expect(agentPhaseLabel('busy.compacting')).toBe('Compacting conversation');
    expect(agentPhaseLabel('wait.llm')).toBe('Waiting for LLM response');
    expect(agentPhaseLabel('wait.tool')).toBe('Waiting for tool');
    expect(agentPhaseLabel('wait.background')).toBe('Background task running');
  });
});
