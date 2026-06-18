/**
 * MCP config loader — reads .coderix/mcp.json from project and user dirs,
 * merges them (project overrides user), and returns validated configs.
 *
 * Phase 2 adds write support (addMcpConfig, removeMcpConfig).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  type ScopedServerConfig,
  type ServerConfig,
  type McpJsonConfig,
  McpJsonConfigSchema,
  type ConfigScope,
} from './types.js';

// ── Config file paths ──────────────────────────────────────────────────

export function projectConfigPath(cwd: string): string {
  return join(cwd, '.coderix', 'mcp.json');
}

export function userConfigPath(): string {
  return join(homedir(), '.coderix', 'mcp.json');
}

function configPathForScope(scope: ConfigScope, cwd?: string): string {
  if (scope === 'project') return projectConfigPath(cwd ?? process.cwd());
  return userConfigPath();
}

// ── Internal helpers ───────────────────────────────────────────────────

function loadJsonFile(path: string): McpJsonConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return McpJsonConfigSchema.parse(parsed);
  } catch {
    return null;
  }
}

function readRawJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function attachScope(
  servers: Record<string, ServerConfig>,
  scope: ConfigScope,
): Record<string, ScopedServerConfig> {
  const result: Record<string, ScopedServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    result[name] = { ...config, scope };
  }
  return result;
}

// ── Loading ────────────────────────────────────────────────────────────

/**
 * Load all MCP server configs, merged across scopes.
 *
 * Priority (low → high):
 *   1. User config   (~/.coderix/mcp.json)
 *   2. Project config (.coderix/mcp.json)
 *
 * Project configs override user configs with the same server name.
 */
export function loadMcpConfigs(cwd: string): Record<string, ScopedServerConfig> {
  const userConfig = loadJsonFile(userConfigPath());
  const projectConfig = loadJsonFile(projectConfigPath(cwd));

  const merged: Record<string, ScopedServerConfig> = {};

  if (userConfig) {
    Object.assign(merged, attachScope(userConfig.mcpServers, 'user'));
  }

  if (projectConfig) {
    Object.assign(merged, attachScope(projectConfig.mcpServers, 'project'));
  }

  return merged;
}

/** Check if any MCP servers are configured for this project. */
export function hasMcpConfig(cwd: string): boolean {
  return Object.keys(loadMcpConfigs(cwd)).length > 0;
}

// ── Writing (Phase 2) ──────────────────────────────────────────────────

/**
 * Add or update an MCP server config in the given scope.
 * Reading/writing raw JSON preserves comments and formatting that
 * Zod would strip.
 */
export function addMcpConfig(
  name: string,
  config: ServerConfig,
  scope: ConfigScope = 'local',
  cwd?: string,
): void {
  const filePath = configPathForScope(scope, cwd);
  const existing = readRawJsonFile(filePath) ?? {};
  const servers = (existing.mcpServers as Record<string, unknown>) ?? {};
  servers[name] = config;
  existing.mcpServers = servers;
  writeJsonFile(filePath, existing);
}

/**
 * Remove an MCP server config from the given scope.
 */
export function removeMcpConfig(
  name: string,
  scope: ConfigScope = 'local',
  cwd?: string,
): void {
  const filePath = configPathForScope(scope, cwd);
  const existing = readRawJsonFile(filePath);
  if (!existing) return;

  const servers = (existing.mcpServers as Record<string, unknown>) ?? {};
  delete servers[name];
  existing.mcpServers = servers;

  if (Object.keys(servers).length === 0 && Object.keys(existing).length === 1) {
    // Remove empty config file
    unlinkSync(filePath);
    return;
  }

  writeJsonFile(filePath, existing);
}

/**
 * Get a single server config by name (searches all scopes, project wins).
 */
export function getMcpConfig(
  name: string,
  cwd?: string,
): ScopedServerConfig | undefined {
  const configs = loadMcpConfigs(cwd ?? process.cwd());
  return configs[name];
}

/**
 * List all configured server names.
 */
export function listMcpServerNames(cwd?: string): string[] {
  return Object.keys(loadMcpConfigs(cwd ?? process.cwd()));
}

// ── Enable / Disable (Phase 2 refined) ──────────────────────────────────

const DISABLED_KEY = 'disabledServers';

/** Get the set of disabled server names from the given file. */
function getDisabledSet(filePath: string): Set<string> {
  const raw = readRawJsonFile(filePath);
  if (!raw) return new Set();
  const list = raw[DISABLED_KEY];
  if (Array.isArray(list)) return new Set(list.filter((x): x is string => typeof x === 'string'));
  return new Set();
}

/** Write the disabled server set back to the file. */
function writeDisabledSet(filePath: string, set: Set<string>): void {
  const existing = readRawJsonFile(filePath) ?? {};
  if (set.size === 0) {
    delete existing[DISABLED_KEY];
  } else {
    existing[DISABLED_KEY] = [...set].sort();
  }
  if (Object.keys(existing).length === 0) {
    if (existsSync(filePath)) unlinkSync(filePath);
    return;
  }
  writeJsonFile(filePath, existing);
}

/** Check if a server is disabled in its config file. */
export function isServerDisabled(name: string, scope: ConfigScope, cwd?: string): boolean {
  const filePath = configPathForScope(scope, cwd);
  return getDisabledSet(filePath).has(name);
}

/** Disable a server (add it to the disabledServers list in its config file). */
export function disableServer(name: string, scope: ConfigScope, cwd?: string): void {
  const filePath = configPathForScope(scope, cwd);
  const set = getDisabledSet(filePath);
  set.add(name);
  writeDisabledSet(filePath, set);
}

/** Enable a server (remove it from the disabledServers list). */
export function enableServer(name: string, scope: ConfigScope, cwd?: string): void {
  const filePath = configPathForScope(scope, cwd);
  const set = getDisabledSet(filePath);
  set.delete(name);
  writeDisabledSet(filePath, set);
}

/**
 * Load all MCP server configs, merged across scopes, filtering out disabled servers.
 * This overload is used by McpManager to get only enabled servers.
 */
export function loadEnabledMcpConfigs(cwd: string): Record<string, ScopedServerConfig> {
  const all = loadMcpConfigs(cwd);
  const filtered: Record<string, ScopedServerConfig> = {};
  for (const [name, config] of Object.entries(all)) {
    if (!isServerDisabled(name, config.scope, cwd)) {
      filtered[name] = config;
    }
  }
  return filtered;
}

/**
 * Get all disabled server names across all scopes.
 */
export function listDisabledServerNames(cwd?: string): Array<{ name: string; scope: ConfigScope }> {
  const result: Array<{ name: string; scope: ConfigScope }> = [];
  const userPath = userConfigPath();
  const projectPath = projectConfigPath(cwd ?? process.cwd());

  for (const name of getDisabledSet(projectPath)) {
    result.push({ name, scope: 'project' as ConfigScope });
  }
  for (const name of getDisabledSet(userPath)) {
    // Project-scoped entries take precedence
    if (!result.some(e => e.name === name && e.scope === 'project')) {
      result.push({ name, scope: 'user' as ConfigScope });
    }
  }
  return result;
}
