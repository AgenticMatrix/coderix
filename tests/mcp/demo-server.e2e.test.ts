/**
 * Demo MCP — end-to-end test against the standalone stdio server.
 *
 * Spawns examples/mcp/demo-server.mjs with a real MCP client and exercises
 * tools + prompts over the wire. This is the "external server" integration path.
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '../../examples/mcp/demo-server.mjs');

describe('examples/mcp/demo-server.mjs (e2e)', () => {
  it('lists tools, calls echo, and lists prompts', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
    });
    const client = new Client({ name: 'coderix-test', version: '0.0.0' }, { capabilities: {} });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['echo', 'get_time', 'calc', 'server_info']));

      const echoed = await client.callTool({ name: 'echo', arguments: { message: 'ping' } });
      expect(echoed.content).toEqual([{ type: 'text', text: 'ping' }]);

      const summed = await client.callTool({ name: 'calc', arguments: { operation: 'add', a: 40, b: 2 } });
      expect((summed.content as Array<{ text?: string }>)[0]?.text).toBe('42');

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['greet', 'summarize']));

      const prompt = await client.getPrompt({ name: 'greet', arguments: { name: 'Ada' } });
      expect(JSON.stringify(prompt.messages)).toContain('Ada');
    } finally {
      await client.close();
    }
  }, 20_000);
});
