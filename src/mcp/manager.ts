/**
 * McpManager — main entry point for MCP integration in Coderix.
 *
 * Orchestrates:
 *  1. Loading server configs from .coderix/mcp.json
 *  2. Connecting to configured servers
 *  3. Discovering tools from each server
 *  4. Converting MCP tools to ToolPlugin format for ToolRegistry
 *
 * Usage from CLI (src/cli/main.tsx):
 *
 *   const mcpManager = new McpManager(process.cwd());
 *   await mcpManager.initialize();
 *   const mcpPlugins = mcpManager.getToolPlugins();
 *   // Register mcpPlugins alongside built-in tools
 */

import type { ToolPlugin } from '../tools/types.js';
import { loadMcpConfigs, hasMcpConfig } from './config-loader.js';
import { connectToServer } from './connection.js';
import { discoverTools } from './discovery.js';
import type {
  ServerConnection,
  ConnectedServer,
  ScopedServerConfig,
} from './types.js';

// ── McpManager ──────────────────────────────────────────────────────────

export class McpManager {
  private cwd: string;
  private connections = new Map<string, ServerConnection>();
  private toolPlugins = new Map<string, ToolPlugin[]>();
  private initialized = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  // ── Initialization ─────────────────────────────────────────────────

  /**
   * Load configs, connect to all configured servers, and discover tools.
   *
   * This is the main entry point. Call once during app startup.
   * Errors from individual servers are collected but don't block startup —
   * failed servers are recorded and can be retried later.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const configs = loadMcpConfigs(this.cwd);

    // Connect to all servers in parallel
    const results = await Promise.allSettled(
      Object.entries(configs).map(async ([name, config]) => {
        const connection = await connectToServer(name, config, this.cwd);
        this.connections.set(name, connection);

        if (connection.type === 'connected') {
          const plugins = await discoverTools(connection);
          this.toolPlugins.set(name, plugins);
        }
      }),
    );

    // Log failures for debugging (Phase 2: proper logging)
    for (const result of results) {
      if (result.status === 'rejected') {
        // Connection setup threw unexpectedly
        console.error(`[MCP] Unexpected error: ${result.reason}`);
      }
    }

    this.initialized = true;
  }

  // ── Tool access ────────────────────────────────────────────────────

  /**
   * Get all MCP tool plugins ready for registration in ToolRegistry.
   * Must be called after initialize().
   */
  getToolPlugins(): ToolPlugin[] {
    const all: ToolPlugin[] = [];
    for (const plugins of this.toolPlugins.values()) {
      all.push(...plugins);
    }
    return all;
  }

  /**
   * Get tool plugins for a specific server.
   */
  getServerTools(serverName: string): ToolPlugin[] {
    return this.toolPlugins.get(serverName) ?? [];
  }

  // ── Connection status ──────────────────────────────────────────────

  /** Get all server connections (connected, failed, pending, disabled). */
  getConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  /** Get a specific server connection. */
  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  /** List names of all successfully-connected servers. */
  getConnectedServerNames(): string[] {
    const names: string[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.type === 'connected') names.push(name);
    }
    return names;
  }

  /** List names of servers that failed to connect. */
  getFailedServerNames(): string[] {
    const names: string[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.type === 'failed') names.push(name);
    }
    return names;
  }

  /** Total number of MCP tools discovered across all servers. */
  get totalToolCount(): number {
    let count = 0;
    for (const plugins of this.toolPlugins.values()) {
      count += plugins.length;
    }
    return count;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Disconnect from a specific server and remove its tools.
   */
  async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;

    if (conn.type === 'connected') {
      try {
        await conn.cleanup();
      } catch {
        // Best-effort
      }
    }

    this.connections.delete(name);
    this.toolPlugins.delete(name);
  }

  /**
   * Disconnect from all servers. Call during app shutdown.
   */
  async shutdown(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map((n) => this.disconnectServer(n)));
    this.initialized = false;
  }
}

// ── Convenience export ──────────────────────────────────────────────────

export { loadMcpConfigs, hasMcpConfig } from './config-loader.js';
