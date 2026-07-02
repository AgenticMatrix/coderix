/**
 * MCP Tool Plugin — wraps an MCP server tool as a Coderix ToolPlugin.
 *
 * Tool naming: `mcp__<serverName>__<toolName>` to prevent collisions
 * with built-in tools and to clearly identify the source.
 */

import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolPlugin, ToolResult } from '../tools/types.js';

// ── Options ────────────────────────────────────────────────────────────

export interface McpToolOptions {
  /** The MCP server's configured name. */
  serverName: string;
  /** The tool name as reported by the server (without mcp__ prefix). */
  toolName: string;
  /** Tool description (already truncated by the caller). */
  description: string;
  /** Tool input JSON Schema. */
  inputSchema: Record<string, unknown>;
  /** Tool annotations from the MCP server (optional). */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    title?: string;
  };
  /** The connected MCP client used to call the tool. */
  client: Client;
}

// ── Name helpers ────────────────────────────────────────────────────────

/** Build the fully-qualified tool name: `mcp__<server>__<tool>`. */
export function buildMcpToolName(serverName: string, toolName: string): string {
  // Sanitize: replace non-alphanumeric chars with underscores
  const safeServer = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${safeServer}__${safeTool}`;
}

/** Parse back the server and original tool name from the fully-qualified name. */
export function parseMcpToolName(fullName: string): {
  serverName: string;
  toolName: string;
} | null {
  const match = fullName.match(/^mcp__([^_].+?)__(.+)$/);
  if (!match) return null;
  return { serverName: match[1]!, toolName: match[2]! };
}

// ── Plugin factory ──────────────────────────────────────────────────────

/**
 * Create a ToolPlugin that wraps an MCP server tool.
 *
 * The returned plugin can be registered directly into Coderix's ToolRegistry
 * alongside built-in tools. Execution is routed through the MCP client's
 * `callTool()` method.
 */
export function createMcpToolPlugin(options: McpToolOptions): ToolPlugin {
  const { serverName, toolName, description, inputSchema, annotations, client } =
    options;

  const fullName = buildMcpToolName(serverName, toolName);

  const riskLevel: 'safe' | 'mutation' | 'destructive' =
    annotations?.destructiveHint
      ? 'destructive'
      : annotations?.readOnlyHint
        ? 'safe'
        : 'mutation';

  return {
    name: fullName,

    schema: {
      name: fullName,
      description: `[MCP:${serverName}] ${description}`,
      input_schema: {
        type: 'object',
        properties: (inputSchema.properties as Record<string, unknown>) ?? {},
        ...(inputSchema.required
          ? { required: inputSchema.required as string[] }
          : {}),
      },
      _meta: {
        riskLevel,
        isConcurrencySafe: annotations?.readOnlyHint ?? false,
      },
    },

    executor: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const startTime = Date.now();

      try {
        const result = await client.callTool(
          {
            name: toolName,
            arguments: input,
          },
          CallToolResultSchema,
          {
            timeout: 120_000, // 2 min default
          },
        );

        // Extract text content from the result
        const textParts: string[] = [];
        const contents = Array.isArray(result.content)
          ? result.content
          : [result.content];

        for (const item of contents) {
          if (item && typeof item === 'object') {
            if ('text' in item && typeof item.text === 'string') {
              textParts.push(item.text);
            } else if (
              'type' in item &&
              (item as { type: string }).type === 'text' &&
              'text' in item
            ) {
              textParts.push(String((item as { text: unknown }).text));
            } else if (
              'type' in item &&
              (item as { type: string }).type === 'image'
            ) {
              textParts.push('[Image content — not displayed in text mode]');
            } else if (
              'type' in item &&
              (item as { type: string }).type === 'resource'
            ) {
              textParts.push(
                `[Resource: ${JSON.stringify((item as { resource?: unknown }).resource)}]`,
              );
            }
          }
        }

        const content = textParts.join('\n') || JSON.stringify(result);
        const isError = 'isError' in result ? Boolean(result.isError) : false;

        return {
          content,
          isError,
          duration: Date.now() - startTime,
        };
      } catch (err) {
        return {
          content: `MCP tool "${toolName}" on server "${serverName}" failed: ${(err as Error).message}`,
          isError: true,
          duration: Date.now() - startTime,
        };
      }
    },

    paramSummary: (input: Record<string, unknown>) => {
      // Show a compact summary, e.g. first value or key names
      const keys = Object.keys(input);
      if (keys.length === 0) return toolName;
      const firstVal = input[keys[0]!];
      if (typeof firstVal === 'string' && firstVal.length <= 40) {
        return firstVal;
      }
      return keys.length === 1 ? keys[0]! : `${keys.length} args`;
    },

    isEnabled: () => true,
  };
}
