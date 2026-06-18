/**
 * MCP tool & resource discovery — calls tools/list and resources/list on
 * connected servers.
 */

import {
  ListToolsResultSchema,
  type ListToolsResult,
  ListResourcesResultSchema,
  type ListResourcesResult,
  ReadResourceResultSchema,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolPlugin } from '../tools/types.js';
import type { ConnectedServer, ServerResource } from './types.js';
import { createMcpToolPlugin } from './mcp-tool.js';

// ── Constants ──────────────────────────────────────────────────────────

const MAX_DESCRIPTION_LENGTH = 2048;

// ── Tool Discovery ─────────────────────────────────────────────────────

export async function discoverTools(
  server: ConnectedServer,
): Promise<ToolPlugin[]> {
  if (!server.capabilities?.tools) return [];

  let result: ListToolsResult;
  try {
    result = (await server.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )) as ListToolsResult;
  } catch {
    return [];
  }

  if (!result.tools || result.tools.length === 0) return [];

  return result.tools.map((tool) => {
    const description =
      (tool.description ?? '').length > MAX_DESCRIPTION_LENGTH
        ? (tool.description ?? '').slice(0, MAX_DESCRIPTION_LENGTH) + '…'
        : (tool.description ?? '');

    const inputSchema =
      (tool.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      };

    return createMcpToolPlugin({
      serverName: server.name,
      toolName: tool.name,
      description,
      inputSchema,
      annotations: tool.annotations as
        | { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
        | undefined,
      client: server.client,
    });
  });
}

// ── Resource Discovery ─────────────────────────────────────────────────

/**
 * Discover resources exposed by an MCP server.
 * Resources are data sources like files, database tables, or API endpoints
 * that can be read by the LLM.
 */
export async function discoverResources(
  server: ConnectedServer,
): Promise<ServerResource[]> {
  if (!server.capabilities?.resources) return [];

  try {
    const result = (await server.client.request(
      { method: 'resources/list' },
      ListResourcesResultSchema,
    )) as ListResourcesResult;

    if (!result.resources) return [];

    return result.resources.map((r) => ({
      ...r,
      server: server.name,
    }));
  } catch {
    return [];
  }
}

/**
 * Read a specific resource by URI from a connected server.
 */
export async function readResource(
  server: ConnectedServer,
  uri: string,
): Promise<ReadResourceResult | null> {
  if (!server.capabilities?.resources) return null;

  try {
    const result = (await server.client.request(
      { method: 'resources/read', params: { uri } },
      ReadResourceResultSchema,
    )) as ReadResourceResult;
    return result;
  } catch {
    return null;
  }
}
