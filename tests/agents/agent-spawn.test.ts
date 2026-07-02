import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../../packages/coderix-core/src/core/agent-registry.js';
import { SubAgentRegistry } from '../../packages/coderix-core/src/core/subagent-registry.js';
import { ToolRegistry } from '../../packages/coderix-core/src/core/tool-registry.js';
import { SessionManager } from '../../packages/coderix-core/src/core/session.js';
import { SystemPromptAssembler } from '../../packages/coderix-core/src/core/system-prompt.js';
import type { AgentSpawnContext, ToolDefinition } from '../../packages/coderix-core/src/core/types.js';

// Import the executor's internal runAgentLoop helper — not directly exported,
// so we test through the public execute interface.

function makeToolDef(name: string): ToolDefinition {
  return { name, description: `${name} tool`, input_schema: { type: 'object', properties: {} } };
}

function buildAgentSpawn(overrides: Partial<AgentSpawnContext> = {}): AgentSpawnContext {
  const toolRegistry = new ToolRegistry();
  ['bash', 'read', 'write', 'edit', 'glob', 'grep'].forEach(n => {
    toolRegistry.register(makeToolDef(n), async () => ({ content: `${n} ok`, isError: false }));
  });

  const sm = new SessionManager();
  sm.create({ cwd: '/tmp', model: 'test' });

  return {
    callModel: vi.fn() as unknown as AgentSpawnContext['callModel'],
    toolRegistry,
    sessionManager: sm,
    subAgentRegistry: new SubAgentRegistry(),
    systemPromptAssembler: new SystemPromptAssembler(),
    agentRegistry: new AgentRegistry(),
    ...overrides,
  };
}

describe('Agent tool background execution', () => {
  it('should return immediately for background agent with placeholder result', async () => {
    const agentSpawn = buildAgentSpawn();

    // Register an agent definition with background: true
    agentSpawn.agentRegistry.register({
      agentType: 'bg-test',
      source: 'built-in',
      baseDir: 'built-in',
      whenToUse: 'Background test agent',
      tools: '*',
      background: true,
      maxTurns: 1,
      getSystemPrompt: () => 'You are a background test agent. Say done.',
    });

    const { execute } = await import('../../packages/coderix-core/src/agents/agent-spawn/executor.js');

    const startTime = Date.now();
    const result = await execute(
      { agent_type: 'bg-test', prompt: 'Hello' },
      { agentSpawn, sessionId: 'test', cwd: '/tmp', signal: new AbortController().signal },
    );

    const elapsed = Date.now() - startTime;

    // Should return very quickly (< 100ms since callModel is a mock that
    // will never resolve in this test context)
    expect(elapsed).toBeLessThan(500);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Background agent');
    expect(result.metadata).toMatchObject({ background: true });
  });

  it('should return background:true in metadata for overridden background', async () => {
    const agentSpawn = buildAgentSpawn();

    // Register a non-background agent
    agentSpawn.agentRegistry.register({
      agentType: 'sync-agent',
      source: 'built-in',
      baseDir: 'built-in',
      whenToUse: 'Sync agent',
      tools: '*',
      background: false,
      maxTurns: 1,
      getSystemPrompt: () => 'You are a sync agent.',
    });

    const { execute } = await import('../../packages/coderix-core/src/agents/agent-spawn/executor.js');

    const result = await execute(
      { agent_type: 'sync-agent', prompt: 'Hello', background: true },
      { agentSpawn, sessionId: 'test', cwd: '/tmp', signal: new AbortController().signal },
    );

    expect(result.metadata).toMatchObject({ background: true });
  });
});

describe('SubAgentRegistry notifications', () => {
  it('should drain pending notifications', () => {
    const registry = new SubAgentRegistry();

    expect(registry.drainNotifications()).toEqual([]);

    registry.pushNotification('Agent sub-abc done.');
    registry.pushNotification('Agent sub-def done.');

    const drained = registry.drainNotifications();
    expect(drained).toEqual(['Agent sub-abc done.', 'Agent sub-def done.']);

    // Second drain should be empty
    expect(registry.drainNotifications()).toEqual([]);
  });

  it('should produce structured <task-notification> via notifyAgentCompletion', () => {
    const registry = new SubAgentRegistry();
    registry.register({
      id: 'sub-xyz',
      name: 'explore-sub-xyz',
      agentType: 'explore',
      status: 'done',
      prompt: 'Find all test files',
      createdAt: Date.now() - 10_000,
      finishedAt: Date.now(),
      turnCount: 3,
      messageCount: 12,
      toolCount: 5,
      result: 'Found 8 test files in ./tests/',
      abortController: new AbortController(),
    });

    const notification = registry.notifyAgentCompletion('sub-xyz');
    expect(notification).not.toBeNull();
    expect(notification!).toContain('<task-notification>');
    expect(notification!).toContain('<task_id>sub-xyz</task_id>');
    expect(notification!).toContain('<agent_type>explore</agent_type>');
    expect(notification!).toContain('<status>completed</status>');
    expect(notification!).toContain('<turns>3</turns>');
    expect(notification!).toContain('<tools_used>5</tools_used>');
    expect(notification!).toContain('<result>Found 8 test files in ./tests/</result>');
    expect(notification!).toContain('</task-notification>');

    const drained = registry.drainNotifications();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toBe(notification);

    // Second call should be a no-op (deduplication)
    const second = registry.notifyAgentCompletion('sub-xyz');
    expect(second).toBeNull();
    expect(registry.drainNotifications()).toEqual([]);
  });

  it('should produce error status for errored agents', () => {
    const registry = new SubAgentRegistry();
    registry.register({
      id: 'sub-err',
      name: 'plan-sub-err',
      agentType: 'plan',
      status: 'error',
      prompt: 'Plan the refactor',
      createdAt: Date.now() - 5_000,
      finishedAt: Date.now(),
      turnCount: 1,
      messageCount: 3,
      toolCount: 2,
      error: 'API key expired',
      abortController: new AbortController(),
    });

    const notification = registry.notifyAgentCompletion('sub-err');
    expect(notification).not.toBeNull();
    expect(notification!).toContain('<status>failed</status>');
    expect(notification!).toContain('<error>API key expired</error>');
  });

  it('should return null for unknown agent', () => {
    const registry = new SubAgentRegistry();
    expect(registry.notifyAgentCompletion('nonexistent')).toBeNull();
  });
});
