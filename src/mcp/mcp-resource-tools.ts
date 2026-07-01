/**
 * MCP Resource Tool Plugins — expose ListMcpResources and ReadMcpResource
 * as LLM-callable tools via the McpManager instance.
 *
 * Follows the same factory pattern as mcp-tool.ts: the manager is captured
 * via closure so the plugins stay live across reconnects.
 */

import type { ToolPlugin, ToolSchema, ToolResult } from '../tools/types.js';
import type { McpManager } from './manager.js';
import { readResource } from './discovery.js';

// ── Schemas ──────────────────────────────────────────────────────────────

const listSchema: ToolSchema = {
  name: 'ListMcpResources',
  description:
    'List MCP resources across connected MCP servers. ' +
    'Resources are data sources (files, database tables, API endpoints, etc.) ' +
    'exposed by MCP servers. ' +
    'Use this to discover what resources are available, then call ReadMcpResource ' +
    'to read a specific resource by server name and URI.',
  input_schema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description:
          'Optional server name to filter resources by. ' +
          'If omitted, lists resources from all connected servers.',
      },
    },
    required: [],
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};

const readSchema: ToolSchema = {
  name: 'ReadMcpResource',
  description:
    'Read a specific MCP resource by server name and resource URI. ' +
    'Use ListMcpResources first to discover available resource URIs. ' +
    'Supports both text and binary (blob) resources.',
  input_schema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'The MCP server name that exposes the resource.',
      },
      uri: {
        type: 'string',
        description:
          'The resource URI to read, as listed by ListMcpResources.',
      },
    },
    required: ['server', 'uri'],
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};

// ── ListMcpResources Plugin ──────────────────────────────────────────────

export function createListMcpResourcesPlugin(
  manager: McpManager,
): ToolPlugin {
  return {
    name: 'ListMcpResources',
    schema: listSchema,

    executor: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const startTime = Date.now();
      const serverFilter = input.server as string | undefined;

      if (serverFilter) {
        const conn = manager.getConnection(serverFilter);
        if (!conn) {
          return {
            content: `Server "${serverFilter}" is not connected or does not exist.`,
            isError: true,
            duration: Date.now() - startTime,
          };
        }
        if (conn.type !== 'connected') {
          return {
            content: `Server "${serverFilter}" is not in connected state (current: ${conn.type}).`,
            isError: true,
            duration: Date.now() - startTime,
          };
        }

        const resources = manager.getServerResources(serverFilter);
        if (resources.length === 0) {
          return {
            content: `No resources available from server "${serverFilter}".`,
            isError: false,
            duration: Date.now() - startTime,
            metadata: { resources: [], count: 0, serverCount: 1 },
          };
        }

        const lines = formatResourceList(
          new Map([[serverFilter, resources]]),
        );
        return {
          content: lines.join('\n'),
          isError: false,
          duration: Date.now() - startTime,
          metadata: {
            resources: resources.map((r) => ({
              server: r.server,
              uri: r.uri,
              name: r.name,
            })),
            count: resources.length,
            serverCount: 1,
          },
        };
      }

      // List all resources from all servers
      const allResources = manager.getAllResources();
      if (allResources.length === 0) {
        return {
          content:
            'No MCP resources available. ' +
            'Connect to MCP servers that support the resources capability.',
          isError: false,
          duration: Date.now() - startTime,
          metadata: { resources: [], count: 0, serverCount: 0 },
        };
      }

      const byServer = new Map<string, typeof allResources>();
      for (const r of allResources) {
        const list = byServer.get(r.server);
        if (list) list.push(r);
        else byServer.set(r.server, [r]);
      }

      const lines = formatResourceList(byServer);
      return {
        content: lines.join('\n'),
        isError: false,
        duration: Date.now() - startTime,
        metadata: {
          resources: allResources.map((r) => ({
            server: r.server,
            uri: r.uri,
            name: r.name,
          })),
          count: allResources.length,
          serverCount: byServer.size,
        },
      };
    },

    paramSummary: (input: Record<string, unknown>) => {
      const s = input.server as string | undefined;
      return s ? `server: ${s}` : 'all servers';
    },

    isEnabled: () => true,
  };
}

// ── ReadMcpResource Plugin ───────────────────────────────────────────────

export function createReadMcpResourcePlugin(
  manager: McpManager,
): ToolPlugin {
  return {
    name: 'ReadMcpResource',
    schema: readSchema,

    executor: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const startTime = Date.now();
      const serverName = input.server as string;
      const uri = input.uri as string;

      const conn = manager.getConnection(serverName);
      if (!conn) {
        return {
          content: `Server "${serverName}" is not connected or does not exist.`,
          isError: true,
          duration: Date.now() - startTime,
        };
      }
      if (conn.type !== 'connected') {
        return {
          content: `Server "${serverName}" is not in connected state (current: ${conn.type}).`,
          isError: true,
          duration: Date.now() - startTime,
        };
      }

      if (!conn.capabilities?.resources) {
        return {
          content: `Server "${serverName}" does not support resources.`,
          isError: true,
          duration: Date.now() - startTime,
        };
      }

      const result = await readResource(conn, uri);
      if (!result) {
        return {
          content: `Failed to read resource "${uri}" from server "${serverName}". The resource may not exist or the server returned an error.`,
          isError: true,
          duration: Date.now() - startTime,
        };
      }

      const contents = Array.isArray(result.contents)
        ? result.contents
        : [result.contents];

      if (contents.length === 0) {
        return {
          content: `Resource "${uri}" returned empty contents.`,
          isError: false,
          duration: Date.now() - startTime,
          metadata: { server: serverName, uri, contentCount: 0 },
        };
      }

      const parts: string[] = [
        `=== Resource: ${uri} ===`,
        `Server: ${serverName}`,
      ];

      for (let i = 0; i < contents.length; i++) {
        const item = contents[i]! as Record<string, unknown>;
        if (contents.length > 1) {
          parts.push(`--- Content part ${i + 1}/${contents.length} ---`);
        }

        if (typeof item.text === 'string') {
          if (item.mimeType) {
            parts.push(`MIME type: ${item.mimeType as string}`);
          }
          parts.push('');
          const text = item.text as string;
          if (text.length > 50_000) {
            parts.push(text.slice(0, 50_000));
            parts.push('');
            parts.push(
              `[Content truncated: ${text.length} total chars, showing first 50,000]`,
            );
          } else {
            parts.push(text);
          }
        } else if (typeof item.blob === 'string') {
          if (item.mimeType) {
            parts.push(`MIME type: ${item.mimeType as string} (binary)`);
          }
          parts.push('');
          const blob = item.blob as string;
          const blobSize = blob.length;
          parts.push(`[Binary data: base64-encoded blob, ${blobSize} bytes]`);
          parts.push(blob.slice(0, 500) + (blobSize > 500 ? '...' : ''));
        } else {
          parts.push(JSON.stringify(item));
        }

        if (i < contents.length - 1) parts.push('');
      }

      parts.push('');
      parts.push('=== End of resource ===');

      return {
        content: parts.join('\n'),
        isError: false,
        duration: Date.now() - startTime,
        metadata: {
          server: serverName,
          uri,
          mimeType: (contents[0] as Record<string, unknown>).mimeType as
            | string
            | undefined,
          contentCount: contents.length,
        },
      };
    },

    paramSummary: (input: Record<string, unknown>) => {
      const uri = input.uri as string;
      // Show a compact URI: trim scheme prefix if long
      if (uri.length <= 50) return uri;
      return uri.slice(0, 47) + '...';
    },

    isEnabled: () => true,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function formatResourceList(
  byServer: Map<string, Array<{ name: string; uri: string; description?: string; mimeType?: string; size?: number }>>,
): string[] {
  const lines: string[] = [];
  let totalCount = 0;
  for (const [, resources] of byServer) totalCount += resources.length;

  lines.push(
    `${totalCount} MCP resource(s) from ${byServer.size} server(s):`,
    '',
  );

  for (const [server, resources] of byServer) {
    lines.push(`[${server}]`);
    for (const r of resources) {
      const name = r.name || r.uri || '(unnamed)';
      const detail = r.mimeType ? ` (${r.mimeType})` : '';
      const sizeStr = r.size != null ? `, ${formatSize(r.size)}` : '';
      lines.push(`  - ${r.uri}${detail}${sizeStr}`);
      if (r.description) {
        const desc =
          r.description.length > 120
            ? r.description.slice(0, 117) + '...'
            : r.description;
        lines.push(`    ${desc}`);
      }
    }
    lines.push('');
  }

  return lines;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
