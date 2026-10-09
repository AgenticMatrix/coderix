/**
 * Standalone MCP connection test — connects to a server, lists its tools, and
 * disconnects, WITHOUT touching any McpManager state. Used by the desktop
 * 链接器's「测试连接」action (mirrors agentstation's `/api/mcp/servers/:name/test`).
 */

import { ListToolsResultSchema, type ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import type { ScopedServerConfig } from './types.js';
import { connectToServer } from './connection.js';

export interface McpTestTool {
  name: string;
  description?: string;
}

export interface McpTestResult {
  ok: boolean;
  tools?: McpTestTool[];
  error?: string;
}

const LIST_TOOLS_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Connect to `config` and return the server's tool list. Always disconnects
 * before resolving; never throws — failures come back as `{ ok: false, error }`.
 */
export async function testMcpServer(
  serverName: string,
  config: ScopedServerConfig,
  cwd: string,
): Promise<McpTestResult> {
  let conn;
  try {
    conn = await connectToServer(serverName, config, cwd);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (conn.type !== 'connected') {
    const error =
      conn.type === 'failed'
        ? conn.error ?? 'Connection failed'
        : conn.type === 'needs-auth'
          ? 'Server requires OAuth authorization'
          : `Server not connected (${conn.type})`;
    return { ok: false, error };
  }

  try {
    const res = (await withTimeout(
      conn.client.request({ method: 'tools/list' }, ListToolsResultSchema),
      LIST_TOOLS_TIMEOUT_MS,
      'listTools',
    )) as ListToolsResult;
    return {
      ok: true,
      tools: (res.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      await conn.cleanup();
    } catch {
      /* ignore */
    }
  }
}
