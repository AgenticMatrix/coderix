/**
 * Demo MCP — Tool schema validation tests.
 */

import { describe, it, expect } from 'vitest';
import { DEMO_TOOLS } from '../../../../packages/coderix-core/src/mcp/builtin/demo-mcp/tools.js';

describe('DEMO_TOOLS', () => {
  it('exposes four tools', () => {
    expect(DEMO_TOOLS).toHaveLength(4);
  });

  it('every tool has name, description and an object inputSchema', () => {
    for (const tool of DEMO_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('every tool name is unique', () => {
    const names = DEMO_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('echo requires a message', () => {
    const echo = DEMO_TOOLS.find((t) => t.name === 'echo');
    expect(echo?.inputSchema.required).toContain('message');
  });

  it('calc requires operation, a and b', () => {
    const calc = DEMO_TOOLS.find((t) => t.name === 'calc');
    expect(calc?.inputSchema.required).toEqual(['operation', 'a', 'b']);
  });

  it('calc operation is a closed enum', () => {
    const calc = DEMO_TOOLS.find((t) => t.name === 'calc');
    const op = (calc?.inputSchema.properties as Record<string, { enum?: string[] }>).operation;
    expect(op.enum).toEqual(['add', 'subtract', 'multiply', 'divide']);
  });
});
