/**
 * MCP connection — establishes and tears down connections to MCP servers.
 *
 * Uses the official @modelcontextprotocol/sdk for transport implementations.
 * Supports stdio (subprocess) and Streamable HTTP transports.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
  ConnectedServer,
  FailedServer,
  ScopedServerConfig,
  ServerConnection,
} from './types.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Default timeout for establishing a connection (30s). */
export const CONNECT_TIMEOUT_MS = 30_000;

// ── Transport factory ──────────────────────────────────────────────────

/**
 * Create the appropriate MCP Transport for a server config.
 * Returns null for unsupported transport types.
 */
function createTransport(
  name: string,
  config: ScopedServerConfig,
): Transport | null {
  // Determine effective type: defaults to 'stdio' for process-based configs
  const effectiveType = config.type || 'stdio';

  switch (effectiveType) {
    case 'stdio': {
      if (!('command' in config)) return null;
      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env as Record<string, string> | undefined,
        stderr: 'inherit', // Forward stderr for debugging
      });
    }

    case 'http': {
      if (!('url' in config)) return null;
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: config.headers
            ? { headers: config.headers as Record<string, string> }
            : undefined,
        },
      );
    }

    case 'sse': {
      if (!('url' in config)) return null;
      return new SSEClientTransport(
        new URL(config.url),
        {
          requestInit: config.headers
            ? { headers: config.headers as Record<string, string> }
            : undefined,
        },
      );
    }

    default:
      return null;
  }
}

// ── Client creation ────────────────────────────────────────────────────

/**
 * Create a configured MCP Client with standard capabilities.
 * The client is NOT connected — call client.connect(transport) after.
 */
function createClient(name: string, cwd: string): Client {
  const client = new Client(
    {
      name: 'coderix',
      version: '0.1.0',
    },
    {
      capabilities: {
        roots: {},
      },
    },
  );

  // Handle ListRoots requests — tell the server our working directory
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: `file://${cwd}` }],
  }));

  return client;
}

// ── Connection ─────────────────────────────────────────────────────────

/**
 * Connect to an MCP server and return the connection state.
 *
 * On success, returns a ConnectedServer with:
 *   - client: the connected MCP Client (for tool discovery & execution)
 *   - cleanup: a function to disconnect and release resources
 *
 * On failure, returns a FailedServer with error details.
 */
export async function connectToServer(
  serverName: string,
  config: ScopedServerConfig,
  cwd: string,
): Promise<ServerConnection> {
  const transport = createTransport(serverName, config);

  if (!transport) {
    return {
      name: serverName,
      type: 'failed',
      config,
      error: `Unsupported transport: ${config.type ?? 'stdio'} (missing command/url)`,
    };
  }

  const client = createClient(serverName, cwd);

  try {
    // Connect with timeout
    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      `Connection to "${serverName}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s`,
    );

    const capabilities = client.getServerCapabilities() ?? {};
    const serverInfo = client.getServerVersion()
      ? { name: client.getServerVersion()!.name, version: client.getServerVersion()!.version }
      : undefined;
    const instructions = client.getInstructions() ?? undefined;

    const cleanup = async () => {
      try {
        await client.close();
      } catch {
        // Best-effort cleanup
      }
    };

    return {
      name: serverName,
      type: 'connected',
      client,
      capabilities,
      serverInfo,
      instructions,
      config,
      cleanup,
    };
  } catch (err) {
    // Clean up partial connection
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }

    return {
      name: serverName,
      type: 'failed',
      config,
      error: (err as Error).message,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

/**
 * Check if two server configs match by signature (for dedup).
 * Returns null for configs that can't be compared.
 */
export function getServerSignature(config: ScopedServerConfig): string | null {
  if ('command' in config && config.command) {
    const parts = [config.command, ...(config.args ?? [])];
    return `stdio:${JSON.stringify(parts)}`;
  }
  if ('url' in config && config.url) {
    return `url:${config.url}`;
  }
  return null;
}
