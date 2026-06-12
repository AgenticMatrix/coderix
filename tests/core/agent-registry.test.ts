import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import type { AgentDefinition } from '../../src/core/types.js';

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType: 'test',
    whenToUse: 'Test agent',
    tools: ['bash', 'read', 'glob'],
    getSystemPrompt: () => 'You are a test agent.',
    ...overrides,
  };
}

describe('AgentRegistry', () => {
  it('should register an agent definition', () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent({ agentType: 'explore' }));
    expect(registry.get('explore')).toBeDefined();
    expect(registry.get('explore')!.agentType).toBe('explore');
  });

  it('should return undefined for unknown agent type', () => {
    const registry = new AgentRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should list all registered agents', () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent({ agentType: 'explore' }));
    registry.register(makeAgent({ agentType: 'plan' }));
    expect(registry.list()).toHaveLength(2);
  });

  it('should override when registering same agentType twice', () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent({ agentType: 'explore', whenToUse: 'v1' }));
    registry.register(makeAgent({ agentType: 'explore', whenToUse: 'v2' }));
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('explore')!.whenToUse).toBe('v2');
  });

  it('getDefinitionsResult should return active and all agents', () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent({ agentType: 'explore' }));
    const result = registry.getDefinitionsResult();
    expect(result.activeAgents).toHaveLength(1);
    expect(result.allAgents).toHaveLength(1);
  });

  it('should return agent system prompt', () => {
    const registry = new AgentRegistry();
    registry.register(makeAgent({
      agentType: 'custom',
      getSystemPrompt: () => 'Custom prompt!',
    }));
    expect(registry.get('custom')!.getSystemPrompt()).toBe('Custom prompt!');
  });
});
