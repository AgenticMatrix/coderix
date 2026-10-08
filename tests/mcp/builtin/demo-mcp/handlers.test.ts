/**
 * Demo MCP — Tool handler behaviour tests.
 */

import { describe, it, expect } from 'vitest';
import { handleDemoToolCall } from '../../../../packages/coderix-core/src/mcp/builtin/demo-mcp/handlers.js';

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('handleDemoToolCall', () => {
  describe('echo', () => {
    it('returns the message verbatim', async () => {
      const result = await handleDemoToolCall('echo', { message: 'hello world' });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe('hello world');
    });

    it('errors when message is missing', async () => {
      const result = await handleDemoToolCall('echo', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_time', () => {
    it('returns an ISO-8601 timestamp', async () => {
      const result = await handleDemoToolCall('get_time', {});
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('honours a valid timezone', async () => {
      const result = await handleDemoToolCall('get_time', { timezone: 'UTC' });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('UTC');
    });

    it('errors on an unknown timezone', async () => {
      const result = await handleDemoToolCall('get_time', { timezone: 'Not/AZone' });
      expect(result.isError).toBe(true);
    });
  });

  describe('calc', () => {
    it.each([
      ['add', 2, 3, '5'],
      ['subtract', 9, 4, '5'],
      ['multiply', 3, 4, '12'],
      ['divide', 10, 4, '2.5'],
    ])('%s(%i, %i) = %s', async (operation, a, b, expected) => {
      const result = await handleDemoToolCall('calc', { operation, a, b });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe(expected);
    });

    it('rejects division by zero', async () => {
      const result = await handleDemoToolCall('calc', { operation: 'divide', a: 1, b: 0 });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('zero');
    });

    it('rejects a non-numeric operand', async () => {
      const result = await handleDemoToolCall('calc', { operation: 'add', a: '1', b: 2 });
      expect(result.isError).toBe(true);
    });

    it('rejects an unsupported operation', async () => {
      const result = await handleDemoToolCall('calc', { operation: 'pow', a: 2, b: 3 });
      expect(result.isError).toBe(true);
    });
  });

  describe('server_info', () => {
    it('lists the exposed tools', async () => {
      const result = await handleDemoToolCall('server_info', {});
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toContain('echo');
      expect(firstText(result)).toContain('calc');
    });
  });

  it('errors on an unknown tool', async () => {
    const result = await handleDemoToolCall('nope', {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Unknown tool');
  });
});
