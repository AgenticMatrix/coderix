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
import type { ServerCapabilities, Resource } from '@modelcontextprotocol/sdk/types.js';

// ── Config Scope ────────────────────────────────────────────────────────

export const ConfigScope = z.enum(['local', 'user', 'project']);
export type ConfigScope = z.infer<typeof ConfigScope>;

// ── Transport Type ──────────────────────────────────────────────────────

export const TransportType = z.enum(['stdio', 'http', 'sse']);
export type Transport = z.infer<typeof TransportType>;

// ── Server Config Schemas ───────────────────────────────────────────────

/** stdio transport: spawns a child process and talks JSON-RPC over stdin/stdout. */
export const StdioServerConfigSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1, 'Command cannot be empty'),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Names of environment variables this server needs as secrets (e.g.
   * `["GITHUB_PERSONAL_ACCESS_TOKEN"]`). Values are never stored in config —
   * they live in `~/.coderix/mcp/secrets.json` and are merged into `env` at
   * connect time. Lets a shared, secret-free config declare what to prompt for.
   */
  secretEnv: z.array(z.string()).optional(),
});
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;

/**
 * OAuth configuration for remote (http/sse) servers.
 * `authorization_code` runs the interactive PKCE flow; `client_credentials`
 * is non-interactive (no browser round-trip).
 */
export const McpOAuthConfigSchema = z.object({
  type: z.enum(['authorization_code', 'client_credentials']).default('authorization_code'),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scope: z.string().optional(),
  /** Loopback port for the OAuth redirect; defaults to 7777. */
  callbackPort: z.number().int().positive().optional(),
  /** Skip RFC 9728/8414 discovery and use this authorization server metadata URL. */
  authorizationServerMetadataUrl: z.string().url().optional(),
});
export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;

/** Streamable HTTP transport (MCP spec 2025). */
export const HttpServerConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string().min(1, 'URL cannot be empty'),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: McpOAuthConfigSchema.optional(),
});
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;

/** SSE transport — Server-Sent Events (most common remote MCP transport). */
export const SSEServerConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string().min(1, 'URL cannot be empty'),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: McpOAuthConfigSchema.optional(),
});
export type SSEServerConfig = z.infer<typeof SSEServerConfigSchema>;

/** Union of all supported server config types. */
export const ServerConfigSchema = z.union([
  StdioServerConfigSchema,
  HttpServerConfigSchema,
  SSEServerConfigSchema,
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
  /** Which primitives the server will push `*_list_changed` notifications for. */
  listChanged?: { tools?: boolean; resources?: boolean; prompts?: boolean };
}

export interface FailedServer {
  name: string;
  type: 'failed';
  config: ScopedServerConfig;
  error?: string;
}

export interface NeedsAuthServer {
  name: string;
  type: 'needs-auth';
  config: ScopedServerConfig;
  /** URL the user must open to complete the OAuth authorization. */
  authorizationUrl?: string;
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
  | NeedsAuthServer
  | PendingServer
  | DisabledServer;

// ── Resource types ────────────────────────────────────────────────────

export type ServerResource = Resource & { server: string };

// ── Prompt types ──────────────────────────────────────────────────────

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** A prompt template exposed by an MCP server (via `prompts/list`). */
export interface McpPrompt {
  serverName: string;
  /** Prompt name as reported by the server (without `mcp__` prefix). */
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

// ── Serialized MCP Tool (for CLI / debug) ──────────────────────────────

export interface SerializedMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  originalToolName: string;
}
