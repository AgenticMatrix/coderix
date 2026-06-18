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
} from '../mcp/config-loader.js';
import { connectToServer } from '../mcp/connection.js';
import type { ScopedServerConfig, ServerConfig } from '../mcp/types.js';
import { StdioServerConfigSchema, HttpServerConfigSchema } from '../mcp/types.js';

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
    default:
      console.log(`Usage: coderix mcp <add|remove|list> [options]`);
      console.log('');
      console.log('Commands:');
      console.log('  add     Add an MCP server');
      console.log('  remove  Remove an MCP server');
      console.log('  list    List configured MCP servers');
      console.log('');
      console.log('Examples:');
      console.log('  coderix mcp add my-tools -- npx -y @anthropic-ai/mcp-server-time');
      console.log('  coderix mcp add --transport http my-api https://mcp.example.com/mcp');
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

  if (transport === 'http') {
    if (positional.length < 2) {
      console.error('Usage: coderix mcp add --transport http <name> <url>');
      process.exit(1);
    }
    const [name, url] = positional;
    const headers = parseKeyValuePairs(options.header);
    const config: ServerConfig = {
      type: 'http',
      url: url!,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
    addMcpConfig(name!, config, (options.scope as 'local' | 'user' | 'project') ?? 'local');
    console.log(`Added HTTP MCP server "${name!}" → ${url!}`);
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
    let detail = '';
    if ('command' in config) {
      detail = `${config.command} ${(config.args ?? []).join(' ')}`;
    } else if ('url' in config) {
      detail = config.url;
    }

    // Quick health check
    let status = '';
    try {
      const conn = await connectToServer(name, config, process.cwd());
      status = conn.type === 'connected'
        ? `✓ ${conn.capabilities?.tools ? 'tools' : 'connected'}`
        : `✗ ${conn.type === 'failed' ? conn.error : conn.type}`;
      if (conn.type === 'connected') await conn.cleanup();
    } catch {
      status = '✗ error';
    }

    console.log(`  ${name} [${transport}] [${scope}]`);
    console.log(`    → ${detail}`);
    console.log(`    Status: ${status}`);
    console.log('');
  }

  console.log('Config files:');
  console.log(`  User:    ${userConfigPath()}`);
  console.log(`  Project: ${projectConfigPath(process.cwd())}`);
  process.exit(0);
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
