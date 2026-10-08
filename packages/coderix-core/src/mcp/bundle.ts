/**
 * MCP bundle — paths for the installed server package.
 *
 * The repo ships an `mcp/` directory (a secret-free server catalog in
 * `mcp/config.json`). `install.sh` copies it to `~/.coderix/mcp/` on first
 * install and leaves it alone afterwards. The app loads servers from that
 * installed directory, so user edits survive reinstalls.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** `~/.coderix/mcp` — the installed MCP bundle directory. */
export function installedMcpDir(): string {
  return join(homedir(), '.coderix', 'mcp');
}

/** `~/.coderix/mcp/config.json` — the installed server catalog. */
export function installedConfigPath(): string {
  return join(installedMcpDir(), 'config.json');
}

/** `~/.coderix/mcp/secrets.json` — per-server env secrets (never committed). */
export function mcpSecretsPath(): string {
  return join(installedMcpDir(), 'secrets.json');
}
