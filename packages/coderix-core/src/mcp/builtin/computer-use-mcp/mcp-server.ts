/**
 * Computer Use MCP — Server Factory + Subprocess Entry Point.
 *
 * createComputerUseMcpServer(): creates a standard MCP Server with all Computer Use tools.
 * runComputerUseMcpServer():    starts the server over stdio as a subprocess.
 *
 * Usage as subprocess:
 *   coderix --computer-use-mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { COMPUTER_TOOLS } from './tools.js';
import { handleComputerToolCall } from './handlers.js';
import { onShutdownSignal } from '../../../utils/platform.js';

/**
 * Create an MCP Server pre-configured with all Computer Use tools.
 * Call server.connect(transport) to activate.
 */
export function createComputerUseMcpServer(): Server {
  const server = new Server(
    {
      name: 'coder-computer-use-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    },
  );

  // ── tools/list ─────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: COMPUTER_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // ── tools/call ─────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const { name, arguments: args } = params;

    try {
      const content = await handleComputerToolCall(
        name,
        (args ?? {}) as Record<string, unknown>,
      );

      return { content };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Computer Use tool "${name}" error: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Start the Computer Use MCP server over stdio (subprocess entry point).
 * Blocks until stdin closes.
 */
export async function runComputerUseMcpServer(): Promise<void> {
  const log = (msg: string) => {
    process.stderr.write(`[coder-computer-use-mcp] ${msg}\n`);
  };

  // Verify required tools are available
  const requiredTools = ['screencapture', 'cliclick', 'osascript', 'pbpaste', 'pbcopy'];
  const missing: string[] = [];
  for (const tool of requiredTools) {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`which ${tool}`, { stdio: 'pipe' });
    } catch {
      missing.push(tool);
    }
  }

  if (missing.length > 0) {
    log(`WARNING: Some tools are missing: ${missing.join(', ')}`);
    log('Computer Use may not work fully without these tools.');
    if (missing.includes('cliclick')) {
      log('Install cliclick: brew install cliclick');
    }
  }

  log('Starting Computer Use MCP server...');

  const server = createComputerUseMcpServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('MCP server ready on stdio');
  log('Supported tools: screenshot, click, type, key, scroll, drag, and more.');

  // Keep alive until stdin closes
  await new Promise<void>((resolve) => onShutdownSignal(resolve));

  log('Shutting down...');
  await server.close();
}
