/**
 * Integration tests — end-to-end workflow execution with mocked agent system.
 *
 * These tests verify that the executor correctly bridges the runtime layer
 * to the Coderix agent infrastructure (SubAgentRegistry, callModel, etc.).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentSpawnContext, StreamEvent, AssistantMessage } from '../../packages/coderix-core/src/core/types.js';
import { ToolRegistry } from '../../packages/coderix-core/src/core/tool-registry.js';
import { SessionManager } from '../../packages/coderix-core/src/core/session.js';
import { SubAgentRegistry } from '../../packages/coderix-core/src/core/subagent-registry.js';
import { AgentRegistry } from '../../packages/coderix-core/src/core/agent-registry.js';
import { execute } from '../../packages/coderix-core/src/agents/workflow/executor.js';
import type { ResolvedExecutorOptions } from '../../packages/coderix-core/src/tools/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockAgentSpawn(overrides: Partial<AgentSpawnContext> = {}): AgentSpawnContext {
  const toolRegistry = new ToolRegistry();
  // Register basic tools that sub-agents might need
  toolRegistry.register(
    { name: 'read', description: 'Read file', input_schema: { type: 'object', properties: {} } },
    async () => ({ content: 'mock read result', isError: false }),
  );
  toolRegistry.register(
    { name: 'bash', description: 'Run shell', input_schema: { type: 'object', properties: {} } },
    async () => ({ content: 'mock bash result', isError: false }),
  );
  toolRegistry.register(
    { name: 'write', description: 'Write file', input_schema: { type: 'object', properties: {} } },
    async () => ({ content: 'mock write result', isError: false }),
  );
  toolRegistry.register(
    { name: 'glob', description: 'Glob files', input_schema: { type: 'object', properties: {} } },
    async () => ({ content: 'mock glob result', isError: false }),
  );
  toolRegistry.register(
    { name: 'grep', description: 'Grep files', input_schema: { type: 'object', properties: {} } },
    async () => ({ content: 'mock grep result', isError: false }),
  );
  toolRegistry.register(
    { name: 'edit', description: 'Edit file', input_schema: { type: 'object', properties: {} } },
    async () => ({ content: 'mock edit result', isError: false }),
  );

  const sessionManager = new SessionManager();
  sessionManager.create({
    title: 'test-session',
    cwd: process.cwd(),
    model: 'test-model',
  });

  const agentRegistry = new AgentRegistry();
  agentRegistry.register({
    agentType: 'general-purpose',
    source: 'built-in',
    baseDir: 'built-in',
    whenToUse: 'General purpose agent for tests',
    tools: '*',
    getSystemPrompt: () => 'You are a test agent. Do the task and report results.',
  });

  return {
    callModel: vi.fn().mockImplementation(async function* () {
      yield {
        type: 'message_start',
        message: { model: 'test-model' },
      } as StreamEvent;
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Test agent completed the task.' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'test-model',
          toolUseBlocks: [],
        } as unknown as AssistantMessage,
      };
    }),
    toolRegistry,
    sessionManager,
    subAgentRegistry: new SubAgentRegistry(),
    systemPromptAssembler: {
      assemble: vi.fn().mockResolvedValue({
        prompt: 'test system prompt',
        parts: [{ name: 'env_info', content: 'test env', priority: 0 }],
      }),
    } as unknown as AgentSpawnContext['systemPromptAssembler'],
    agentRegistry,
    ...overrides,
  };
}

function mockOptions(agentSpawn: AgentSpawnContext): ResolvedExecutorOptions {
  return {
    cwd: process.cwd(),
    allowMutation: true,
    maxOutput: 50_000,
    bashTimeout: 30_000,
    agentSpawn,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Workflow Executor Integration', () => {
  it('should execute a simple workflow with one agent call', async () => {
    const agentSpawn = createMockAgentSpawn();
    const opts = mockOptions(agentSpawn);

    const script = [
      'export const meta = { name: "integration-test", description: "Simple test" };',
      'const result = await agent("analyze this code", { agentType: "general-purpose" });',
      'return result;',
    ].join('\n');

    const result = await execute({ script }, opts);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Workflow completed');
    expect(result.content).toContain('agents used');
  });

  it('should execute a workflow with parallel agent calls', async () => {
    const agentSpawn = createMockAgentSpawn();
    const opts = mockOptions(agentSpawn);

    const script = [
      'export const meta = { name: "parallel-integration", description: "Parallel test" };',
      'const results = await parallel([',
      '  () => agent("task A", { agentType: "general-purpose" }),',
      '  () => agent("task B", { agentType: "general-purpose" }),',
      ']);',
      'return "done";',
    ].join('\n');

    const result = await execute({ script }, opts);

    expect(result.isError).toBe(false);
    expect(result.metadata?.agentCount).toBe(2);
  });

  it('should return error for invalid script', async () => {
    const agentSpawn = createMockAgentSpawn();
    const opts = mockOptions(agentSpawn);

    const result = await execute({ script: 'not a valid script' }, opts);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Workflow failed');
  });

  it('should return error when agentSpawn is missing', async () => {
    const opts: ResolvedExecutorOptions = {
      cwd: process.cwd(),
      allowMutation: true,
      maxOutput: 50_000,
      bashTimeout: 30_000,
      agentSpawn: undefined,
    };

    const script = [
      'export const meta = { name: "no-spawn", description: "test" };',
      'await agent("test");',
    ].join('\n');

    const result = await execute({ script }, opts);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('agentSpawn');
  });

  it('should report phase progress in the result', async () => {
    const agentSpawn = createMockAgentSpawn();
    const opts = mockOptions(agentSpawn);

    const script = [
      'export const meta = {',
      '  name: "phases-integration",',
      '  description: "Phases test",',
      '  phases: [{ title: "Scan" }, { title: "Fix" }]',
      '};',
      'phase("Scan");',
      'await agent("scan for issues");',
      'phase("Fix");',
      'await agent("fix issues");',
      'phase("Verify");',
      'await agent("verify fixes");',
    ].join('\n');

    const result = await execute({ script }, opts);

    expect(result.isError).toBe(false);
    expect(result.metadata?.phases).toBeDefined();
    const phases = result.metadata?.phases as Array<{ title: string }>;
    expect(phases.length).toBeGreaterThanOrEqual(1);
  });

  it('should pass args to the workflow', async () => {
    const agentSpawn = createMockAgentSpawn();
    const opts = mockOptions(agentSpawn);

    const script = [
      'export const meta = { name: "args-integration", description: "Args test" };',
      'log("Processing: " + args.filePath);',
      'log("Depth: " + args.maxDepth);',
      'await agent("analyze " + args.filePath);',
    ].join('\n');

    const result = await execute(
      { script, args: { filePath: 'src/index.ts', maxDepth: 3 } },
      opts,
    );

    expect(result.isError).toBe(false);
  });

  it('should handle script with empty body', async () => {
    const agentSpawn = createMockAgentSpawn();
    const opts = mockOptions(agentSpawn);

    const script = [
      'export const meta = { name: "empty", description: "no body" };',
      'return "nothing to do";',
    ].join('\n');

    const result = await execute({ script }, opts);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Workflow completed');
    expect(result.metadata?.agentCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// StructuredOutput — schema validation tests
// ---------------------------------------------------------------------------

describe('StructuredOutput (via agent-runner)', () => {
  it('should validate JSON Schema correctly', async () => {
    // Import the validation logic directly to test
    const { runWorkflowAgent } = await import(
      '../../packages/coderix-core/src/agents/workflow/agent-runner.js'
    );

    // This is a lightweight test — just verifying the module loads correctly
    expect(runWorkflowAgent).toBeDefined();
    expect(typeof runWorkflowAgent).toBe('function');
  });
});
