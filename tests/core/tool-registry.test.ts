import { describe, expect, it, beforeEach } from 'vitest';
import { ToolRegistry } from '../../packages/coderix-core/src/core/tool-registry.js';
import { createToolRegistry, plugins } from '../../packages/coderix-core/src/tools/registry.js';
import type { ToolDefinition, ToolContext, ToolExecutionResult } from '../../packages/coderix-core/src/core/types.js';

function makeDef(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    input_schema: { type: 'object', properties: {} },
  };
}

async function noop(): Promise<ToolExecutionResult> {
  return { content: 'ok', isError: false };
}

const CTX: ToolContext = { sessionId: 's1', cwd: '/tmp' };

describe('ToolRegistry', () => {
  let reg: ToolRegistry;

  beforeEach(() => {
    reg = new ToolRegistry();
  });

  it('should register a tool', () => {
    reg.register(makeDef('Read'), noop);
    expect(reg.names).toContain('Read');
  });

  it('should get a registered tool', () => {
    reg.register(makeDef('Read'), noop);
    const entry = reg.get('Read');
    expect(entry).toBeDefined();
    expect(entry!.definition.name).toBe('Read');
  });

  it('should return undefined for unknown tool', () => {
    expect(reg.get('Unknown')).toBeUndefined();
  });

  it('should list all definitions', () => {
    reg.register(makeDef('Read'), noop);
    reg.register(makeDef('Write'), noop);
    expect(reg.getDefinitions()).toHaveLength(2);
  });

  it('should return Anthropic-compatible tools', () => {
    reg.register(makeDef('Read'), noop);
    const tools = reg.getAnthropicTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('Read');
    expect(tools[0]!.description).toBe('Read tool');
    // Must not leak internal _meta
    expect((tools[0]! as any)._meta).toBeUndefined();
  });

  it('should execute a registered tool', async () => {
    reg.register(makeDef('Read'), async (input) => ({
      content: `read ${input.path}`, isError: false,
    }));
    const result = await reg.execute('Read', { path: '/f.txt' }, CTX);
    expect(result.content).toContain('read /f.txt');
    expect(result.isError).toBe(false);
  });

  it('should return error for unknown tool execution', async () => {
    const result = await reg.execute('Unknown', {}, CTX);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('should list all names', () => {
    reg.register(makeDef('Read'), noop);
    reg.register(makeDef('Write'), noop);
    expect(reg.names.sort()).toEqual(['Read', 'Write']);
  });
});

describe('createToolRegistry (single source of truth)', () => {
  it('should register exactly the enabled core plugins', () => {
    const expected = plugins
      .filter((p) => !p.isEnabled || p.isEnabled())
      .map((p) => p.name);
    expect(createToolRegistry().names.sort()).toEqual(expected.sort());
  });

  it('should include the sub-agent Agent tool so every frontend can spawn sub-agents', () => {
    expect(createToolRegistry().names).toContain('Agent');
  });

  it('should append extraPlugins (e.g. MCP tools)', () => {
    const mcp = { name: 'mcp__demo__ping', schema: { name: 'mcp__demo__ping', description: 'ping', input_schema: { type: 'object', properties: {} }, _meta: { riskLevel: 'safe' as const } }, executor: async () => ({ content: 'pong', isError: false }) };
    const names = createToolRegistry({ extraPlugins: [mcp as never] }).names;
    expect(names).toContain('mcp__demo__ping');
    expect(names).toContain('Agent');
  });

  it('should let a host wrap a plugin executor', async () => {
    const registry = createToolRegistry({
      wrapExecutor: (plugin, base) =>
        plugin.name === 'bash'
          ? async () => ({ content: 'intercepted', isError: false })
          : base,
    });
    const result = await registry.execute('bash', { command: 'echo hi' }, CTX);
    expect(result.content).toBe('intercepted');
  });
});
