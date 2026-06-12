import { describe, expect, it } from 'vitest';
import { filterToolsForAgent, ALL_AGENT_DISALLOWED_TOOLS, GLOBAL_DISALLOWED_FOR_SUBAGENTS } from '../../src/agents/tool-filtering.js';
import type { ToolDefinition, AgentDefinition } from '../../src/core/types.js';

function td(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: 'object', properties: {} },
  };
}

function agentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType: 'test',
    whenToUse: 'test agent',
    tools: ['*'],
    disallowedTools: [],
    getSystemPrompt: () => 'test prompt',
    ...overrides,
  };
}

const ALL_TOOLS: ToolDefinition[] = [
  td('bash'), td('read'), td('write'), td('edit'), td('glob'), td('grep'),
  td('web-fetch'), td('web-search'), td('todo-write'),
  td('TaskCreate'), td('TaskUpdate'), td('TaskList'), td('TaskGet'),
  td('agent-spawn'), td('agent-message'), td('agent-stop'), td('agent-read'),
  td('ask-user-question'), td('task-output'), td('exit-plan-mode'),
];

describe('ALL_AGENT_DISALLOWED_TOOLS', () => {
  it('should alias GLOBAL_DISALLOWED_FOR_SUBAGENTS', () => {
    expect(ALL_AGENT_DISALLOWED_TOOLS).toBe(GLOBAL_DISALLOWED_FOR_SUBAGENTS);
  });

  it('should include agent-spawn (prevent recursive sub-agents)', () => {
    expect(ALL_AGENT_DISALLOWED_TOOLS.has('agent-spawn')).toBe(true);
  });

  it('should include agent-message and agent-stop', () => {
    expect(ALL_AGENT_DISALLOWED_TOOLS.has('agent-message')).toBe(true);
    expect(ALL_AGENT_DISALLOWED_TOOLS.has('agent-stop')).toBe(true);
  });

  it('should include ask-user-question', () => {
    expect(ALL_AGENT_DISALLOWED_TOOLS.has('ask-user-question')).toBe(true);
  });
});

describe('filterToolsForAgent', () => {
  it('should remove globally disallowed tools for all agent types', () => {
    const result = filterToolsForAgent(ALL_TOOLS, agentDef());
    expect(result.find(t => t.name === 'agent-spawn')).toBeUndefined();
    expect(result.find(t => t.name === 'agent-message')).toBeUndefined();
    expect(result.find(t => t.name === 'ask-user-question')).toBeUndefined();
  });

  it('should include read/write tools for general-purpose with tools=*', () => {
    const result = filterToolsForAgent(ALL_TOOLS, agentDef({ tools: '*' }));
    expect(result.find(t => t.name === 'bash')).toBeDefined();
    expect(result.find(t => t.name === 'read')).toBeDefined();
    expect(result.find(t => t.name === 'write')).toBeDefined();
  });

  it('should restrict to whitelist when tools is an explicit array', () => {
    const result = filterToolsForAgent(ALL_TOOLS, agentDef({
      tools: ['bash', 'read', 'glob', 'grep'],
    }));
    // Should only contain whitelisted tools
    const names = result.map(t => t.name);
    expect(names).toContain('bash');
    expect(names).toContain('read');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).not.toContain('write');
    expect(names).not.toContain('edit');
  });

  it('should apply agent-specific disallowedTools on top of global', () => {
    const result = filterToolsForAgent(ALL_TOOLS, agentDef({
      tools: '*',
      disallowedTools: ['write', 'edit'],
    }));
    // Globals still removed
    expect(result.find(t => t.name === 'agent-spawn')).toBeUndefined();
    // Agent-specific also removed
    expect(result.find(t => t.name === 'write')).toBeUndefined();
    expect(result.find(t => t.name === 'edit')).toBeUndefined();
    // Others remain
    expect(result.find(t => t.name === 'read')).toBeDefined();
    expect(result.find(t => t.name === 'glob')).toBeDefined();
  });

  it('should handle empty input', () => {
    expect(filterToolsForAgent([], agentDef())).toHaveLength(0);
    expect(filterToolsForAgent([], agentDef({ tools: ['bash'] }))).toHaveLength(0);
  });
});
