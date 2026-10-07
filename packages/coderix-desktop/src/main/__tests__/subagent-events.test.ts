import { describe, it, expect } from 'vitest';
import {
  canonicalSubAgentId,
  normalizeSubAgentEvent,
} from '../subagent-events.js';

describe('canonicalSubAgentId', () => {
  it('prefers the spawning tool_use id over the engine id', () => {
    expect(canonicalSubAgentId('sub-a1b2', 'toolu_123')).toBe('toolu_123');
  });

  it('falls back to the engine id when no tool call spawned the agent', () => {
    expect(canonicalSubAgentId('sub-a1b2')).toBe('sub-a1b2');
    expect(canonicalSubAgentId('sub-a1b2', undefined)).toBe('sub-a1b2');
    expect(canonicalSubAgentId('sub-a1b2', '')).toBe('sub-a1b2');
  });
});

describe('normalizeSubAgentEvent', () => {
  it('re-keys a coderix event by the spawner tool_use id', () => {
    const event = normalizeSubAgentEvent({
      type: 'agent_register',
      agentId: 'sub-a1b2',
      agent: { id: 'sub-a1b2', toolUseId: 'toolu_123', status: 'running' },
    });
    expect(event).toEqual({
      type: 'agent_register',
      agentId: 'toolu_123',
      agent: { id: 'sub-a1b2', toolUseId: 'toolu_123', status: 'running' },
    });
  });

  it('keeps the engine id when the record has no tool_use id', () => {
    const event = normalizeSubAgentEvent({
      type: 'agent_update',
      agentId: 'sub-a1b2',
      agent: { id: 'sub-a1b2', status: 'running' },
    });
    expect(event.agentId).toBe('sub-a1b2');
  });

  it('leaves claude-code events unchanged (its id already is the tool_use id)', () => {
    const event = normalizeSubAgentEvent({
      type: 'agent_update',
      agentId: 'toolu_123',
      agent: { id: 'toolu_123', toolUseId: 'toolu_123', status: 'done' },
    });
    expect(event.agentId).toBe('toolu_123');
  });

  it('drops the record on agent_remove but keeps the key', () => {
    const event = normalizeSubAgentEvent({ type: 'agent_remove', agentId: 'sub-a1b2' });
    expect(event).toEqual({ type: 'agent_remove', agentId: 'sub-a1b2' });
  });

  it('canonicalizes agent_remove when an explicit toolUseId is supplied', () => {
    const event = normalizeSubAgentEvent({
      type: 'agent_remove',
      agentId: 'sub-a1b2',
      toolUseId: 'toolu_123',
    });
    expect(event).toEqual({ type: 'agent_remove', agentId: 'toolu_123' });
  });
});
