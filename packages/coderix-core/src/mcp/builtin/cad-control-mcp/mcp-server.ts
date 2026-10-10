/**
 * CAD Control MCP — Server Factory + Subprocess Entry Point.
 *
 * createCadControlMcpServer(): an MCP Server exposing the CAD-control tools
 *                              (list/render/export/inspect/snapshot/artifact/focus).
 * runCadControlMcpServer():    starts the server over stdio as a subprocess.
 *
 * Usage as subprocess:
 *   coderix --cad-control-mcp
 *
 * Tools drive the cad_harness `cad` skill CLI and the on-screen cad-viewer, so
 * the desktop agent controls the CAD component through this MCP server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CAD_CONTROL_TOOLS } from './tools.js';
import { handleCadControlToolCall } from './handlers.js';
import { onShutdownSignal } from '../../../utils/platform.js';

export function createCadControlMcpServer(): { server: Server } {
  const server = new Server(
    {
      name: 'coderix-cad-control-mcp',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CAD_CONTROL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const { name, arguments: args } = params;
    try {
      return await handleCadControlToolCall(name, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Tool "${name}" error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return { server };
}

/**
 * Start the CAD Control MCP server over stdio (subprocess entry point).
 * Blocks until stdin closes.
 */
export async function runCadControlMcpServer(): Promise<void> {
  const log = (msg: string) => {
    process.stderr.write(`[coderix-cad-control-mcp] ${msg}\n`);
  };

  log('Starting CAD control MCP server on stdio...');

  const { server } = createCadControlMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log(`Ready — ${CAD_CONTROL_TOOLS.length} tools`);

  await new Promise<void>((resolve) => onShutdownSignal(resolve));

  log('Shutting down...');
  await server.close();
}
