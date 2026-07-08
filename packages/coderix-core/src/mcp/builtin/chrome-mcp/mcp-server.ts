/**
 * Chrome Use MCP — Server Factory + Subprocess Entry Point.
 *
 * createChromeMcpServer(): creates a standard MCP Server with all browser tools.
 * runChromeMcpServer():    starts the server over stdio as a subprocess.
 *
 * Usage as subprocess:
 *   coderix --chrome-mcp [--chrome-mcp-port <port>]
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CdpClient, getCdpClient } from './cdp-client.js';
import { BROWSER_TOOLS } from './tools.js';
import { handleBrowserToolCall } from './handlers.js';
import type { CdpConfig } from './types.js';
import { onShutdownSignal } from '../../../utils/platform.js';

/**
 * Create an MCP Server pre-configured with all Chrome Use tools.
 * Call server.connect(transport) to activate.
 */
export function createChromeMcpServer(config?: CdpConfig): {
  server: Server;
  cdpClient: CdpClient;
} {
  const cdpClient = getCdpClient(config);

  const server = new Server(
    {
      name: 'coder-chrome-mcp',
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
    tools: BROWSER_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // ── tools/call ─────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const { name, arguments: args } = params;

    try {
      const content = await handleBrowserToolCall(
        name,
        (args ?? {}) as Record<string, unknown>,
        cdpClient,
      );

      return { content };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Tool "${name}" error: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return { server, cdpClient };
}

/**
 * Start the Chrome MCP server over stdio (subprocess entry point).
 * Blocks until stdin closes.
 */
export async function runChromeMcpServer(
  cdpPort?: number,
): Promise<void> {
  const config: CdpConfig = {};
  if (cdpPort) config.port = cdpPort;

  const log = (msg: string) => {
    // Write to stderr so it doesn't interfere with the MCP protocol on stdout
    process.stderr.write(`[coder-chrome-mcp] ${msg}\n`);
  };

  log(`Starting with CDP port ${config.port ?? 9222}...`);

  const { server, cdpClient } = createChromeMcpServer(config);

  // Try to connect to Chrome early
  try {
    await cdpClient.connect();
    log('Connected to Chrome');
  } catch (err) {
    log(`Warning: Could not connect to Chrome: ${(err as Error).message}`);
    log('The server will start, but tools will error until Chrome is available.');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('MCP server ready on stdio');

  // Keep alive until stdin closes
  await new Promise<void>((resolve) => onShutdownSignal(resolve));

  log('Shutting down...');
  await server.close();
  await cdpClient.shutdown();
}
