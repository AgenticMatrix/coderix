/**
 * MCP Server mode — exposes Coderix's built-in tools as an MCP server
 * so that other MCP clients (VS Code, Claude Desktop, etc.) can call them.
 *
 * Usage: coderix mcp serve
 *
 * Spawns an MCP server over stdio that:
 *  1. Lists all Coderix built-in tools on tools/list
 *  2. Routes tools/call to the corresponding tool executor
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { executeTool, getAnthropicTools } from '../tools/registry.js';
import type { ExecutorOptions } from '../tools/types.js';
import { onShutdownSignal } from '../utils/platform.js';

/**
 * Start Coderix as an MCP server over stdio.
 * This blocks until the transport closes (client disconnects).
 */
export async function startMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: 'coderix',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // ── tools/list — return all Coderix tools as MCP tool definitions ──
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getAnthropicTools();
    return {
      tools: tools.map((t: { name: string; description?: string; input_schema?: Record<string, unknown> }) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.input_schema ?? {
          type: 'object',
          properties: {},
        }) as Record<string, unknown>,
      })),
    };
  });

  // ── tools/call — execute a Coderix tool ────────────────────────────
  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
      const opts: ExecutorOptions = {
        cwd: process.cwd(),
        allowMutation: true,
        maxOutput: 50_000,
        bashTimeout: 30_000,
      };

      try {
        const result = await executeTool(name, args as Record<string, unknown>, opts);

        return {
          content: [
            {
              type: 'text' as const,
              text: result.content,
            },
          ],
          isError: result.isError,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tool "${name}" error: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── Run ────────────────────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the process alive until transport closes
  // StdioServerTransport will close when stdin ends
  await new Promise<void>((resolve) => onShutdownSignal(resolve));

  await server.close();
}
