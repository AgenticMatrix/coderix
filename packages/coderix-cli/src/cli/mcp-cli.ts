/**
 * MCP CLI handler — coderix mcp <subcommand>
 *
 * Subcommands:
 *   coderix mcp add    <name> -- <command> [args...]    (stdio)
 *   coderix mcp add    --transport http <name> <url>     (HTTP)
 *   coderix mcp remove <name> [--scope user|project]
 *   coderix mcp list   [--scope user|project]
 */

import {
  addMcpConfig,
  removeMcpConfig,
  loadMcpConfigs,
  projectConfigPath,
  userConfigPath,
} from '@coderix/core';
import { connectToServer } from '@coderix/core';
import type { ScopedServerConfig, ServerConfig } from '@coderix/core';
import { StdioServerConfigSchema, HttpServerConfigSchema } from '@coderix/core';

// ── CLI argument parsing ───────────────────────────────────────────────

interface McpAddOptions {
  transport?: string;
  scope?: string;
  env?: string[];
  header?: string[];
}

interface McpRemoveOptions {
  scope?: string;
}

/** Parse `coderix mcp ...` args and dispatch to the right handler. */
export async function handleMcpCli(args: string[]): Promise<void> {
  const cmd = args[0];

  switch (cmd) {
    case 'add':
      await handleAdd(args.slice(1));
      break;
    case 'remove':
    case 'rm':
      await handleRemove(args.slice(1));
      break;
    case 'list':
    case 'ls':
      await handleList(args.slice(1));
      break;
    case 'reconnect':
      await handleReconnect(args.slice(1));
      break;
    case 'enable':
      await handleEnable(args.slice(1));
      break;
    case 'disable':
      await handleDisable(args.slice(1));
      break;
    case 'serve':
      await handleServe();
      break;
    default:
      console.log(`Usage: coderix mcp <add|remove|list|reconnect|enable|disable|serve> [options]`);
      console.log('');
      console.log('Commands:');
      console.log('  add        Add an MCP server');
      console.log('  remove     Remove an MCP server');
      console.log('  list       List configured MCP servers');
      console.log('  reconnect  Reconnect to an MCP server');
      console.log('  enable     Enable a disabled MCP server');
      console.log('  disable    Disable an MCP server');
      console.log('  serve      Start Coderix as an MCP server (stdio)');
      console.log('');
      console.log('Examples:');
      console.log('  coderix mcp add my-tools -- npx -y @anthropic-ai/mcp-server-time');
      console.log('  coderix mcp add --transport http my-api https://mcp.example.com/mcp');
      console.log('  coderix mcp remove my-tools');
      console.log('  coderix mcp list');
      console.log('  coderix mcp reconnect my-tools');
      console.log('  coderix mcp disable my-tools');
      console.log('  coderix mcp enable my-tools');
      console.log('  coderix mcp remove my-tools');
      console.log('  coderix mcp list');
      process.exit(0);
  }
}

// ── Add ────────────────────────────────────────────────────────────────

async function handleAdd(args: string[]): Promise<void> {
  const options: McpAddOptions = {};
  const positional: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '--transport' || arg === '-t') {
      options.transport = args[++i];
    } else if (arg === '--scope' || arg === '-s') {
      options.scope = args[++i];
    } else if (arg === '--env' || arg === '-e') {
      options.env = options.env ?? [];
      options.env.push(args[++i]!);
    } else if (arg === '--header' || arg === '-H') {
      options.header = options.header ?? [];
      options.header.push(args[++i]!);
    } else if (arg === '--') {
      // Everything after -- is the command + args
      positional.push(...args.slice(i + 1));
      break;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
    i++;
  }

  const transport = options.transport ?? 'stdio';

  if (transport === 'http' || transport === 'sse') {
    if (positional.length < 2) {
      console.error(`Usage: coderix mcp add --transport ${transport} <name> <url>`);
      process.exit(1);
    }
    const [name, url] = positional;
    const headers = parseKeyValuePairs(options.header);
    const config: ServerConfig = {
      type: transport as 'http' | 'sse',
      url: url!,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
    addMcpConfig(name!, config, (options.scope as 'local' | 'user' | 'project') ?? 'local');
    console.log(`Added ${transport.toUpperCase()} MCP server "${name!}" → ${url!}`);
    console.log(`  Config: ${resolveConfigPath(options.scope ?? 'local')}`);
  } else {
    // stdio
    if (positional.length < 2) {
      console.error('Usage: coderix mcp add <name> -- <command> [args...]');
      console.error('  Use -- to separate the server name from the command');
      process.exit(1);
    }
    const [name, command, ...cmdArgs] = positional;
    const env = parseKeyValuePairs(options.env);
    const config: ServerConfig = {
      type: 'stdio',
      command: command!,
      args: cmdArgs as string[],
      ...(Object.keys(env).length ? { env } : {}),
    };
    addMcpConfig(name!, config, (options.scope as 'local' | 'user' | 'project') ?? 'local');
    console.log(`Added stdio MCP server "${name!}" → ${command} ${(cmdArgs as string[]).join(' ')}`);
    console.log(`  Config: ${resolveConfigPath(options.scope ?? 'local')}`);
  }

  process.exit(0);
}

// ── Remove ─────────────────────────────────────────────────────────────

async function handleRemove(args: string[]): Promise<void> {
  const options: McpRemoveOptions = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--scope' || arg === '-s') {
      options.scope = args[++i];
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length < 1) {
    console.error('Usage: coderix mcp remove <name>');
    process.exit(1);
  }

  const name = positional[0]!;
  removeMcpConfig(name, (options.scope as 'local' | 'user' | 'project') ?? 'local');
  console.log(`Removed MCP server "${name}"`);
  process.exit(0);
}

// ── List ───────────────────────────────────────────────────────────────

async function handleList(args: string[]): Promise<void> {
  let scopeFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scope' || args[i] === '-s') {
      scopeFilter = args[++i];
    }
  }

  const configs = loadMcpConfigs(process.cwd());
  const { isServerDisabled } = await import('@coderix/core');
  const entries = Object.entries(configs).filter(([, c]) =>
    scopeFilter ? c.scope === scopeFilter : true,
  );

  if (entries.length === 0) {
    console.log('No MCP servers configured.');
    console.log('');
    console.log('Add one with:');
    console.log('  coderix mcp add <name> -- <command> [args...]');
    process.exit(0);
  }

  console.log(`${entries.length} MCP server(s):`);
  console.log('');

  for (const [name, config] of entries) {
    const transport = config.type || 'stdio';
    const scope = config.scope;
    const disabled = isServerDisabled(name, scope);
    let detail = '';
    if ('command' in config) {
      detail = `${config.command} ${(config.args ?? []).join(' ')}`;
    } else if ('url' in config) {
      detail = config.url;
    }

    // Status
    let status = '';
    if (disabled) {
      status = '⏸ disabled';
    } else {
      try {
        const conn = await connectToServer(name, config, process.cwd());
        if (conn.type === 'connected') {
          const parts: string[] = [];
          if (conn.capabilities?.tools) parts.push('tools');
          if (conn.capabilities?.resources) parts.push('resources');
          status = `✓ ${parts.length > 0 ? parts.join('+') : 'connected'}`;
        } else {
          status = `✗ ${conn.type === 'failed' ? conn.error : conn.type}`;
        }
        if (conn.type === 'connected') await conn.cleanup();
      } catch {
        status = '✗ error';
      }
    }

    const disabledTag = disabled ? ' [disabled]' : '';
    console.log(`  ${name} [${transport}] [${scope}]${disabledTag}`);
    console.log(`    → ${detail}`);
    console.log(`    Status: ${status}`);
    console.log('');
  }

  console.log('Config files:');
  console.log(`  User:    ${userConfigPath()}`);
  console.log(`  Project: ${projectConfigPath(process.cwd())}`);
  process.exit(0);
}

// ── Reconnect ──────────────────────────────────────────────────────────

async function handleReconnect(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: coderix mcp reconnect <name>');
    process.exit(1);
  }

  const name = args[0]!;
  const { McpManager } = await import('@coderix/core');
  const manager = new McpManager(process.cwd());
  await manager.initialize();

  console.log(`Reconnecting to "${name}"...`);
  const conn = await manager.reconnectServer(name);

  if (conn.type === 'connected') {
    const tools = manager.getServerTools(name);
    console.log(`✓ "${name}" reconnected — ${tools.length} tool(s)`);
  } else {
    console.log(`✗ "${name}" reconnect failed: ${conn.type === 'failed' ? conn.error : conn.type}`);
  }

  await manager.shutdown();
  process.exit(0);
}

// ── Enable ─────────────────────────────────────────────────────────────

async function handleEnable(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: coderix mcp enable <name>');
    process.exit(1);
  }

  const name = args[0]!;
  const { enableServer, getMcpConfig } = await import('@coderix/core');

  const config = getMcpConfig(name);
  if (!config) {
    console.error(`Server "${name}" not found in config.`);
    process.exit(1);
  }

  enableServer(name, config.scope);
  console.log(`✓ "${name}" enabled`);

  const { McpManager } = await import('@coderix/core');
  const manager = new McpManager(process.cwd());
  await manager.initialize();
  const conn = manager.getConnection(name);
  if (conn?.type === 'connected') {
    const tools = manager.getServerTools(name);
    console.log(`  Connected — ${tools.length} tool(s)`);
  } else if (conn?.type === 'failed') {
    console.log(`  ⚠ Tried connecting but failed: ${conn.error ?? 'unknown'}`);
  }
  await manager.shutdown();
  process.exit(0);
}

// ── Disable ────────────────────────────────────────────────────────────

async function handleDisable(args: string[]): Promise<void> {
  if (args.length < 1) {
    console.error('Usage: coderix mcp disable <name>');
    process.exit(1);
  }

  const name = args[0]!;
  const { disableServer, getMcpConfig } = await import('@coderix/core');

  const config = getMcpConfig(name);
  if (!config) {
    console.error(`Server "${name}" not found in config.`);
    process.exit(1);
  }

  disableServer(name, config.scope);
  console.log(`✓ "${name}" disabled`);
  process.exit(0);
}

// ── Serve ──────────────────────────────────────────────────────────────

async function handleServe(): Promise<void> {
  const { startMcpServer } = await import('@coderix/core');
  process.stderr.write('Coderix MCP server starting on stdio...\n');
  process.stderr.write('Connect from VS Code, Claude Desktop, or any MCP client.\n');
  await startMcpServer();
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseKeyValuePairs(
  pairs: string[] | undefined,
): Record<string, string> {
  if (!pairs || pairs.length === 0) return {};
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return result;
}

function resolveConfigPath(scope: string): string {
  if (scope === 'project') return projectConfigPath(process.cwd());
  if (scope === 'user') return userConfigPath();
  // 'local' → project by default
  return projectConfigPath(process.cwd());
}
