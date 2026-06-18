/**
 * MCP tool discovery — calls tools/list on connected servers and converts
 * the results into Coderix ToolPlugin-compatible format.
 */

import {
  ListToolsResultSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolPlugin } from '../tools/types.js';
import type { ConnectedServer } from './types.js';
import { createMcpToolPlugin } from './mcp-tool.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Maximum description length before truncation in the system prompt. */
const MAX_DESCRIPTION_LENGTH = 2048;

// ── Discovery ──────────────────────────────────────────────────────────

/**
 * Discover tools from a connected MCP server.
 *
 * Calls `tools/list` on the server and wraps each tool as a ToolPlugin
 * that routes execution through `client.callTool()`.
 *
 * Returns an empty array if the server doesn't advertise tool capabilities
 * or if the call fails.
 */
export async function discoverTools(
  server: ConnectedServer,
): Promise<ToolPlugin[]> {
  if (!server.capabilities?.tools) {
    return [];
  }

  let result: ListToolsResult;

  try {
    result = (await server.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
    )) as ListToolsResult;
  } catch (err) {
    // Server doesn't support tool listing or the call failed
    return [];
  }

  if (!result.tools || result.tools.length === 0) {
    return [];
  }

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
        | {
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
            title?: string;
          }
        | undefined,
      client: server.client,
    });
  });
}
