/**
 * MCP (Model Context Protocol) types for Coderix.
 *
 * Phase 1 supports:
 *  - stdio transport (subprocess-based)
 *  - Streamable HTTP transport
 *  - Config loading from .coderix/mcp.json
 */

import { z } from 'zod/v4';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';

// ── Config Scope ────────────────────────────────────────────────────────

export const ConfigScope = z.enum(['local', 'user', 'project']);
export type ConfigScope = z.infer<typeof ConfigScope>;

// ── Transport Type ──────────────────────────────────────────────────────

export const TransportType = z.enum(['stdio', 'http']);
export type Transport = z.infer<typeof TransportType>;

// ── Server Config Schemas ───────────────────────────────────────────────

/** stdio transport: spawns a child process and talks JSON-RPC over stdin/stdout. */
export const StdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1, 'Command cannot be empty'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;

/** Streamable HTTP transport (MCP spec 2025). */
export const HttpServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string().min(1, 'URL cannot be empty'),
  headers: z.record(z.string(), z.string()).optional(),
});
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;

/** Union of all supported server config types. */
export const ServerConfigSchema = z.union([
  StdioServerConfigSchema,
  HttpServerConfigSchema,
]);
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** Server config with its source scope attached. */
export type ScopedServerConfig = ServerConfig & { scope: ConfigScope };

// ── MCP JSON Config File ────────────────────────────────────────────────

export const McpJsonConfigSchema = z.object({
  mcpServers: z.record(z.string(), ServerConfigSchema),
});
export type McpJsonConfig = z.infer<typeof McpJsonConfigSchema>;

// ── Connection States ───────────────────────────────────────────────────

export interface ConnectedServer {
  name: string;
  type: 'connected';
  client: Client;
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  config: ScopedServerConfig;
  cleanup: () => Promise<void>;
}

export interface FailedServer {
  name: string;
  type: 'failed';
  config: ScopedServerConfig;
  error?: string;
}

export interface PendingServer {
  name: string;
  type: 'pending';
  config: ScopedServerConfig;
}

export interface DisabledServer {
  name: string;
  type: 'disabled';
  config: ScopedServerConfig;
}

export type ServerConnection =
  | ConnectedServer
  | FailedServer
  | PendingServer
  | DisabledServer;

// ── Serialized MCP Tool (for CLI / debug) ──────────────────────────────

export interface SerializedMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  originalToolName: string;
}
