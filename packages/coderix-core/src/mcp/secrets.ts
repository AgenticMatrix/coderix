/**
 * MCP secrets — per-server environment secrets.
 *
 * Stored at `~/.coderix/mcp/secrets.json` (mode 0600), keyed by server name:
 *   { "github": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…" } }
 *
 * A shared, secret-free `config.json` declares which env vars a server needs
 * (`secretEnv`); the values live here and are merged into the server's `env` at
 * connect time. This file must never be committed or copied into a bundle.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { mcpSecretsPath } from './bundle.js';

export { mcpSecretsPath };

type SecretsStore = Record<string, Record<string, string>>;

function readStore(): SecretsStore {
  const path = mcpSecretsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SecretsStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: SecretsStore): void {
  const path = mcpSecretsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort — some filesystems don't support chmod
  }
}

/** All stored secrets for a server ({} if none). */
export function getServerSecrets(serverName: string): Record<string, string> {
  return readStore()[serverName] ?? {};
}

/** A single stored secret value, or undefined. */
export function getSecret(serverName: string, envVar: string): string | undefined {
  return readStore()[serverName]?.[envVar];
}

/** Store (or overwrite) a secret. Passing an empty value deletes the entry. */
export function setSecret(serverName: string, envVar: string, value: string): void {
  const store = readStore();
  const entry = store[serverName] ?? {};
  if (value === '') {
    delete entry[envVar];
  } else {
    entry[envVar] = value;
  }
  if (Object.keys(entry).length === 0) {
    delete store[serverName];
  } else {
    store[serverName] = entry;
  }
  persist(store);
}

/** Remove all secrets for a server. Returns true if anything was removed. */
export function clearServerSecrets(serverName: string): boolean {
  const store = readStore();
  if (!(serverName in store)) return false;
  delete store[serverName];
  persist(store);
  return true;
}

/** Write the store, or delete the file when there is nothing left to keep. */
function persist(store: SecretsStore): void {
  if (Object.keys(store).length === 0) {
    if (existsSync(mcpSecretsPath())) unlinkSync(mcpSecretsPath());
    return;
  }
  writeStore(store);
}

/** Server names that currently have at least one stored secret. */
export function listServersWithSecrets(): string[] {
  return Object.keys(readStore());
}
