/**
 * /mcp — TUI slash command for MCP server management.
 *
 * Usage:
 *   /mcp               — list all MCP servers with status & tool counts
 *   /mcp <name>        — show details for a specific server
 *   /mcp status        — quick connection status summary
 */

import type { SlashCommand } from '../types.js';
import { loadMcpConfigs } from '../../mcp/config-loader.js';
import { connectToServer } from '../../mcp/connection.js';
import { discoverTools } from '../../mcp/discovery.js';

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  aliases: [],
  help: 'list MCP servers and their status (/mcp [name|status])',
  usage: '/mcp [server-name|status]',
  run(arg, ctx) {
    const trimmed = arg.trim();

    if (trimmed === 'status') {
      void showQuickStatus(ctx);
      return;
    }

    if (trimmed) {
      void showServerDetail(trimmed, ctx);
      return;
    }

    void listServers(ctx);
  },
};

// ── List all servers ───────────────────────────────────────────────────

async function listServers(ctx: {
  sys: (msg: string) => void;
}): Promise<void> {
  const configs = loadMcpConfigs(process.cwd());
  const entries = Object.entries(configs);

  if (entries.length === 0) {
    ctx.sys(
      'No MCP servers configured.\n\n' +
        'Add one from the terminal:\n' +
        '  coderix mcp add my-tools -- npx -y @anthropic-ai/mcp-server-time',
    );
    return;
  }

  ctx.sys(`Checking ${entries.length} MCP server(s)...`);

  const lines: string[] = [`${entries.length} MCP server(s):`, ''];

  for (const [name, config] of entries) {
    const transport = config.type || 'stdio';
    const scope = config.scope;

    // Quick health check
    let status = '⏳ checking...';
    let toolCount = 0;
    try {
      const conn = await connectToServer(name, config, process.cwd());
      if (conn.type === 'connected') {
        const tools = await discoverTools(conn);
        toolCount = tools.length;
        status = `✓ connected (${toolCount} tool(s))`;
        await conn.cleanup();
      } else {
        const errMsg = conn.type === 'failed' ? conn.error : conn.type;
        status = `✗ ${errMsg ?? conn.type}`;
      }
    } catch (err) {
      status = `✗ ${(err as Error).message.slice(0, 60)}`;
    }

    lines.push(`  ${name}  [${transport}]  [${scope}]`);
    lines.push(`    ${status}`);
    lines.push('');
  }

  ctx.sys(lines.join('\n'));
}

// ── Server detail ──────────────────────────────────────────────────────

async function showServerDetail(
  name: string,
  ctx: { sys: (msg: string) => void },
): Promise<void> {
  const configs = loadMcpConfigs(process.cwd());
  const config = configs[name];

  if (!config) {
    ctx.sys(`MCP server "${name}" not found.\n\nUse /mcp to see configured servers.`);
    return;
  }

  const transport = config.type || 'stdio';
  ctx.sys(`Connecting to "${name}"...`);

  try {
    const conn = await connectToServer(name, config, process.cwd());

    if (conn.type !== 'connected') {
      const errDetail = conn.type === 'failed' ? conn.error : conn.type;
      ctx.sys(`✗ "${name}" failed to connect: ${errDetail ?? conn.type}`);
      return;
    }

    const tools = await discoverTools(conn);

    const lines: string[] = [
      `MCP Server: ${name}`,
      `  Transport:  ${transport}`,
      `  Scope:      ${config.scope}`,
      `  Status:     ✓ connected`,
    ];

    if (conn.serverInfo) {
      lines.push(`  Version:    ${conn.serverInfo.name} v${conn.serverInfo.version}`);
    }
    if (conn.capabilities?.tools) {
      lines.push(`  Tools:      ${tools.length}`);
    }
    if (conn.capabilities?.resources) {
      lines.push(`  Resources:  available`);
    }
    if (conn.instructions) {
      const truncated =
        conn.instructions.length > 200
          ? conn.instructions.slice(0, 197) + '...'
          : conn.instructions;
      lines.push(`  Instructions: ${truncated}`);
    }

    if (tools.length > 0) {
      lines.push('');
      lines.push('  Tools:');
      for (const tool of tools) {
        const desc = tool.schema.description ?? '';
        const shortDesc = desc.length > 80 ? desc.slice(0, 77) + '...' : desc;
        const safe = tool.schema._meta.isConcurrencySafe ? '🟢' : '🟡';
        lines.push(`    ${safe} ${tool.name} — ${shortDesc}`);
      }
    }

    await conn.cleanup();
    ctx.sys(lines.join('\n'));
  } catch (err) {
    ctx.sys(`✗ "${name}" error: ${(err as Error).message}`);
  }
}

// ── Quick status ─────────────────────────────────────────────────────────

async function showQuickStatus(ctx: {
  sys: (msg: string) => void;
}): Promise<void> {
  const configs = loadMcpConfigs(process.cwd());
  const entries = Object.entries(configs);

  if (entries.length === 0) {
    ctx.sys('No MCP servers configured.');
    return;
  }

  ctx.sys(`Checking ${entries.length} MCP server(s)...`);

  let connected = 0;
  let failed = 0;
  let totalTools = 0;
  const lines: string[] = [];

  for (const [name, config] of entries) {
    try {
      const conn = await connectToServer(name, config, process.cwd());
      if (conn.type === 'connected') {
        const tools = await discoverTools(conn);
        totalTools += tools.length;
        connected++;
        lines.push(`  ✓ ${name} — ${tools.length} tool(s)`);
        await conn.cleanup();
      } else {
        failed++;
        const errDetail = conn.type === 'failed' ? conn.error : conn.type;
        lines.push(`  ✗ ${name} — ${errDetail ?? conn.type}`);
      }
    } catch (err) {
      failed++;
      lines.push(`  ✗ ${name} — ${(err as Error).message.slice(0, 60)}`);
    }
  }

  const summary = [
    `MCP Status: ${connected}/${entries.length} connected, ${totalTools} total tool(s)`,
    '',
    ...lines,
  ];

  ctx.sys(summary.join('\n'));
}
