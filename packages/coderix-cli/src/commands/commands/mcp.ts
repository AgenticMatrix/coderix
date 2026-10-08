/**
 * /mcp — TUI slash command for MCP server management.
 *
 * Usage:
 *   /mcp                      — list all MCP servers with status & tool counts
 *   /mcp <name>               — show details for a specific server
 *   /mcp status               — quick connection status summary
 *   /mcp enable <name>        — enable a disabled server
 *   /mcp disable <name>       — disable a server
 *   /mcp prompts [server]     — list prompt templates exposed by servers
 *   /mcp prompt <server> <name> [key=value ...] — render & send a prompt
 *   /mcp auth <name>          — how to complete OAuth for a remote server
 */

import type { SlashCommand } from '../types.js';
import {
  loadMcpConfigs,
  isServerDisabled,
  disableServer as disableServerConfig,
  enableServer as enableServerConfig,
} from '@coderix/core';
import { connectToServer } from '@coderix/core';
import { discoverTools } from '@coderix/core';
import { discoverPrompts } from '@coderix/core';
import { getPrompt } from '@coderix/core';
import { renderMcpPromptMessages } from '@coderix/core';
import { parsePromptArgs } from '@coderix/core';

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  aliases: [],
  help: 'manage MCP servers (/mcp [status|enable|disable|prompts|prompt|auth] ...)',
  usage: '/mcp [server-name|status|enable|disable|prompts|prompt|auth] [name]',
  run(arg, ctx) {
    const parts = arg.trim().split(/\s+/);
    const cmd = parts[0] ?? '';
    const name = parts.slice(1).join(' ');

    if (cmd === 'status') {
      void showQuickStatus(ctx);
      return;
    }

    if (cmd === 'enable' && name) {
      void handleEnable(name, ctx);
      return;
    }

    if (cmd === 'disable' && name) {
      void handleDisable(name, ctx);
      return;
    }

    if (cmd === 'prompts') {
      void listPrompts(name, ctx);
      return;
    }

    if (cmd === 'prompt') {
      const [server, prompt, ...rest] = parts.slice(1);
      if (!server || !prompt) {
        ctx.sys('Usage: /mcp prompt <server> <name> [key=value ...]');
        return;
      }
      void invokePrompt(server, prompt, rest.join(' '), ctx);
      return;
    }

    if (cmd === 'auth' && name) {
      handleAuthHint(name, ctx);
      return;
    }

    if (cmd) {
      void showServerDetail(cmd, ctx);
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

// ── Enable server ──────────────────────────────────────────────────────

async function handleEnable(
  name: string,
  ctx: { sys: (msg: string) => void },
): Promise<void> {
  const configs = loadMcpConfigs(process.cwd());
  const config = configs[name];

  if (!config) {
    ctx.sys(`MCP server "${name}" not found in config.`);
    return;
  }

  if (!isServerDisabled(name, config.scope)) {
    ctx.sys(`"${name}" is already enabled.`);
    return;
  }

  enableServerConfig(name, config.scope);
  ctx.sys(`✓ "${name}" enabled — will connect on next startup or use /mcp ${name} to test.`);
}

// ── Disable server ─────────────────────────────────────────────────────

async function handleDisable(
  name: string,
  ctx: { sys: (msg: string) => void },
): Promise<void> {
  const configs = loadMcpConfigs(process.cwd());
  const config = configs[name];

  if (!config) {
    ctx.sys(`MCP server "${name}" not found in config.`);
    return;
  }

  if (isServerDisabled(name, config.scope)) {
    ctx.sys(`"${name}" is already disabled.`);
    return;
  }

  disableServerConfig(name, config.scope);
  ctx.sys(`✓ "${name}" disabled — it will be skipped on next startup.`);
}

// ── Prompts list ───────────────────────────────────────────────────────

async function listPrompts(
  serverFilter: string,
  ctx: { sys: (msg: string) => void },
): Promise<void> {
  const configs = loadMcpConfigs(process.cwd());
  let targets = Object.entries(configs);
  if (serverFilter) {
    targets = targets.filter(([name]) => name === serverFilter);
    if (targets.length === 0) {
      ctx.sys(`MCP server "${serverFilter}" not found.`);
      return;
    }
  }

  const lines: string[] = [];

  for (const [name, config] of targets) {
    try {
      const conn = await connectToServer(name, config, process.cwd());
      if (conn.type !== 'connected') {
        lines.push(`  ✗ ${name} — ${conn.type === 'failed' ? conn.error : conn.type}`);
        continue;
      }
      const prompts = await discoverPrompts(conn);
      await conn.cleanup();

      if (prompts.length === 0) continue;
      lines.push(`${name}:`);
      for (const p of prompts) {
        const args = (p.arguments ?? [])
          .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
          .join(' ');
        const argsPart = args ? ` ${args}` : '';
        const desc = p.description ? ` — ${p.description}` : '';
        lines.push(`  mcp__${name}__${p.name}${argsPart}${desc}`);
      }
      lines.push('');
    } catch (err) {
      lines.push(`  ✗ ${name} — ${(err as Error).message.slice(0, 60)}`);
    }
  }

  if (lines.length === 0) {
    ctx.sys('No MCP prompts available.');
  } else {
    lines.push('Run one with: /mcp prompt <server> <name> [key=value ...]');
    ctx.sys(lines.join('\n'));
  }
}

// ── Prompt invoke ──────────────────────────────────────────────────────

async function invokePrompt(
  serverName: string,
  promptName: string,
  rawArgs: string,
  ctx: { sys: (msg: string) => void; send: (text: string) => void },
): Promise<void> {
  const configs = loadMcpConfigs(process.cwd());
  const config = configs[serverName];
  if (!config) {
    ctx.sys(`MCP server "${serverName}" not found.`);
    return;
  }

  try {
    const conn = await connectToServer(serverName, config, process.cwd());
    if (conn.type !== 'connected') {
      ctx.sys(`✗ "${serverName}" — ${conn.type === 'failed' ? conn.error : conn.type}`);
      return;
    }

    const prompts = await discoverPrompts(conn);
    const prompt = prompts.find((p) => p.name === promptName);
    if (!prompt) {
      await conn.cleanup();
      ctx.sys(`Prompt "${promptName}" not found on "${serverName}".`);
      return;
    }

    const positionalKeys = (prompt.arguments ?? []).map((a) => a.name);
    const args = parsePromptArgs(rawArgs, positionalKeys);
    const result = await getPrompt(conn, promptName, args);
    await conn.cleanup();

    if (!result) {
      ctx.sys(`Failed to render prompt "${promptName}".`);
      return;
    }

    const text = renderMcpPromptMessages(result.messages);
    if (!text) {
      ctx.sys(`Prompt "${promptName}" produced no content.`);
      return;
    }
    ctx.send(text);
  } catch (err) {
    ctx.sys(`✗ "${serverName}" error: ${(err as Error).message}`);
  }
}

// ── OAuth hint ─────────────────────────────────────────────────────────

function handleAuthHint(
  name: string,
  ctx: { sys: (msg: string) => void },
): void {
  const configs = loadMcpConfigs(process.cwd());
  const config = configs[name];
  if (!config) {
    ctx.sys(`MCP server "${name}" not found.`);
    return;
  }
  if (!('url' in config) || !config.oauth) {
    ctx.sys(`"${name}" has no OAuth configuration (only http/sse servers can use OAuth).`);
    return;
  }
  ctx.sys(
    `To authorize "${name}", run from a terminal:\n\n` +
      `  coderix mcp auth ${name}\n\n` +
      `Follow the printed URL, then finish with:\n` +
      `  coderix mcp auth ${name} --code <code>`,
  );
}
