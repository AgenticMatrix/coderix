/**
 * McpManager — main entry point for MCP integration in Coderix.
 *
 * Phase 2 refined:
 *  - Auto-reconnect with exponential backoff
 *  - Enable/disable servers at runtime
 *  - Tool hot-reload on reconnect
 *  - On-change callback for live tool updates
 */

import type { ToolPlugin } from '../tools/types.js';
import {
  loadEnabledMcpConfigs,
  loadMcpConfigs,
  hasMcpConfig,
  isServerDisabled,
  isServerRemoved,
  disableServer as disableServerConfig,
  enableServer as enableServerConfig,
  listDisabledServerNames,
} from './config-loader.js';
import { connectToServer } from './connection.js';
import type { ConnectHooks } from './connection.js';
import { discoverTools, discoverResources, discoverPrompts, getPrompt } from './discovery.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createListMcpResourcesPlugin,
  createReadMcpResourcePlugin,
} from './mcp-resource-tools.js';
import { discoverMcpSkills } from './mcp-skills.js';
import type {
  ServerConnection,
  ConnectedServer,
  ScopedServerConfig,
  ConfigScope,
  Transport,
  ServerResource,
  McpPrompt,
} from './types.js';
import type { McpSkill } from './mcp-skills.js';
import { getCatalogMeta, type McpCatalogMeta } from './catalog.js';
import { getServerSecrets } from './secrets.js';

// ── Reconnect constants ────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;

// ── Types ──────────────────────────────────────────────────────────────

export type ToolsChangedCallback = (serverName: string, plugins: ToolPlugin[]) => void;

/** Fired when any primitive list changes (initial discovery, notification, reconnect). */
export type ServerChangedKind = 'tools' | 'resources' | 'prompts';
export type ServerChangedCallback = (serverName: string, kind: ServerChangedKind) => void;

/** A configured MCP server with its live connection status, for picker UIs. */
export interface McpServerStatus {
  name: string;
  scope: ConfigScope;
  status: ServerConnection['type'] | 'unconnected';
  toolCount: number;
  /** Transport derived from config (defaults to `stdio`). */
  transport?: Transport;
  /** Human-readable launch endpoint: `command + args`, or the remote URL. */
  endpoint?: string;
  /** True when the server is disabled in config (persisted). */
  disabled?: boolean;
  /** True when the server was removed (hidden from the engine, restorable). */
  removed?: boolean;
  /** Env var names this server needs as secrets (stdio servers). */
  secretEnv?: string[];
  /** True when every required secret has a stored value. */
  secretsSet?: boolean;
  /** Display metadata (icon + bilingual name/description/credential/fields). */
  meta?: McpCatalogMeta;
}

// ── McpManager ───────────────────────────────────────────────────────────

export class McpManager {
  private cwd: string;
  private connections = new Map<string, ServerConnection>();
  private toolPlugins = new Map<string, ToolPlugin[]>();
  private serverResources = new Map<string, ServerResource[]>();
  private serverPrompts = new Map<string, McpPrompt[]>();
  private serverSkills = new Map<string, McpSkill[]>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = new Map<string, number>();
  private initialized = false;
  private onChangeCallbacks: ToolsChangedCallback[] = [];
  private onChangedCallbacks: ServerChangedCallback[] = [];

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  // ── Callback registration ──────────────────────────────────────────

  /** Register a callback fired when tools change (connect/reconnect/disconnect). */
  onToolsChanged(cb: ToolsChangedCallback): void {
    this.onChangeCallbacks.push(cb);
  }

  /** Register a callback fired when any primitive list changes. */
  onServerChanged(cb: ServerChangedCallback): void {
    this.onChangedCallbacks.push(cb);
  }

  private notifyToolsChanged(serverName: string): void {
    const plugins = this.toolPlugins.get(serverName) ?? [];
    for (const cb of this.onChangeCallbacks) {
      try {
        cb(serverName, plugins);
      } catch {
        // Don't let one bad callback break the chain
      }
    }
  }

  private notifyServerChanged(serverName: string, kind: ServerChangedKind): void {
    for (const cb of this.onChangedCallbacks) {
      try {
        cb(serverName, kind);
      } catch {
        // Don't let one bad callback break the chain
      }
    }
  }

  // ── Initialization ─────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const configs = loadEnabledMcpConfigs(this.cwd);

    await Promise.allSettled(
      Object.entries(configs).map(async ([name, config]) => {
        await this.connectAndDiscover(name, config);
      }),
    );

    this.initialized = true;
  }

  // ── Connection lifecycle ────────────────────────────────────────────

  /** Connect to a server and discover its tools. Called on init and reconnect. */
  private async connectAndDiscover(
    name: string,
    config: ScopedServerConfig,
  ): Promise<void> {
    // Set pending state
    this.connections.set(name, { name, type: 'pending', config });

    const hooks: ConnectHooks = {
      onToolsListChanged: () => void this.refreshTools(name),
      onResourcesListChanged: () => void this.refreshResources(name),
      onPromptsListChanged: () => void this.refreshPrompts(name),
      onConnectionLost: (error) => this.handleConnectionLost(name, config, error),
    };

    const connection = await connectToServer(name, config, this.cwd, hooks);
    this.connections.set(name, connection);

    if (connection.type === 'connected') {
      this.reconnectAttempts.set(name, 0);
      const plugins = await discoverTools(connection);
      this.toolPlugins.set(name, plugins);
      // Discover resources, prompts and skills
      const resources = await discoverResources(connection);
      if (resources.length > 0) this.serverResources.set(name, resources);
      const prompts = await discoverPrompts(connection);
      if (prompts.length > 0) this.serverPrompts.set(name, prompts);
      const skills = await discoverMcpSkills(connection);
      if (skills.length > 0) this.serverSkills.set(name, skills);
      this.notifyToolsChanged(name);
      this.notifyServerChanged(name, 'tools');
    } else if (connection.type === 'failed') {
      // Schedule reconnect
      this.scheduleReconnect(name, config);
    }
    // 'needs-auth' has no automatic retry — it needs the user to authorize.
  }

  // ── Hot reload (list_changed notifications) ────────────────────────

  private async refreshTools(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (conn?.type !== 'connected') return;
    const plugins = await discoverTools(conn);
    this.toolPlugins.set(name, plugins);
    this.notifyToolsChanged(name);
    this.notifyServerChanged(name, 'tools');
  }

  private async refreshResources(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (conn?.type !== 'connected') return;
    const resources = await discoverResources(conn);
    this.serverResources.set(name, resources);
    this.notifyServerChanged(name, 'resources');
  }

  private async refreshPrompts(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (conn?.type !== 'connected') return;
    const prompts = await discoverPrompts(conn);
    this.serverPrompts.set(name, prompts);
    this.notifyServerChanged(name, 'prompts');
  }

  /** A connected server dropped: clear its state and reconnect with backoff. */
  private handleConnectionLost(
    name: string,
    config: ScopedServerConfig,
    error?: Error,
  ): void {
    if (this.connections.get(name)?.type === 'disabled') return;
    this.connections.set(name, {
      name,
      type: 'failed',
      config,
      error: error?.message ?? 'Connection lost',
    });
    this.toolPlugins.delete(name);
    this.serverResources.delete(name);
    this.serverPrompts.delete(name);
    this.serverSkills.delete(name);
    this.notifyToolsChanged(name);
    this.scheduleReconnect(name, config);
  }

  // ── Reconnection ────────────────────────────────────────────────────

  private scheduleReconnect(name: string, config: ScopedServerConfig): void {
    // Clear any existing timer
    const existing = this.reconnectTimers.get(name);
    if (existing) {
      clearTimeout(existing);
      this.reconnectTimers.delete(name);
    }

    const attempts = this.reconnectAttempts.get(name) ?? 0;
    if (attempts >= MAX_RECONNECT_ATTEMPTS) return;

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempts),
      MAX_RECONNECT_DELAY_MS,
    );

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(name);
      const currentConn = this.connections.get(name);

      // Only reconnect if still in failed/pending state
      if (currentConn && currentConn.type !== 'connected') {
        this.reconnectAttempts.set(name, attempts + 1);
        await this.connectAndDiscover(name, config);
      }
    }, delay);

    this.reconnectTimers.set(name, timer);
  }

  /** Manually reconnect to a server. Resets attempt counter.
   *  Works even on disabled servers — it re-enables and connects. */
  async reconnectServer(name: string): Promise<ServerConnection> {
    // Cancel any pending auto-reconnect
    const existingTimer = this.reconnectTimers.get(name);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.reconnectTimers.delete(name);
    }

    // Disconnect if currently connected
    const current = this.connections.get(name);
    if (current?.type === 'connected') {
      try { await current.cleanup(); } catch { /* ignore */ }
    }

    // Find the config — check connections map first, then raw configs
    let config = current?.config;
    if (!config || current?.type === 'disabled') {
      // Load from unfiltered configs to find disabled servers
      const { loadMcpConfigs } = await import('./config-loader.js');
      const allConfigs = loadMcpConfigs(this.cwd);
      config = allConfigs[name];
    }

    if (!config) {
      const failed: ServerConnection = {
        name,
        type: 'failed',
        config: { command: '', scope: 'local' } as ScopedServerConfig,
        error: 'No config found for this server',
      };
      this.connections.set(name, failed);
      return failed;
    }

    // Re-enable if it was disabled (check config, not just connection state)
    const { isServerDisabled: checkDisabled } = await import('./config-loader.js');
    if (!current || current.type === 'disabled' || checkDisabled(name, config.scope, this.cwd)) {
      const { enableServer: enableConfig } = await import('./config-loader.js');
      enableConfig(name, config.scope, this.cwd);
    }

    this.reconnectAttempts.set(name, 0);
    await this.connectAndDiscover(name, config);
    return this.connections.get(name) ?? {
      name,
      type: 'failed',
      config,
      error: 'Reconnect failed',
    };
  }

  // ── Enable / Disable ─────────────────────────────────────────────────

  /** Disable a server at runtime. Disconnects it and marks it disabled in config. */
  async disableServer(name: string): Promise<void> {
    // Cancel reconnect timers
    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }

    // Disconnect
    const conn = this.connections.get(name);
    if (conn) {
      if (conn.type === 'connected') {
        try { await conn.cleanup(); } catch { /* ignore */ }
      }
      const scope = conn.config.scope;
      disableServerConfig(name, scope, this.cwd);
      this.connections.set(name, {
        name,
        type: 'disabled',
        config: conn.config,
      });
      this.toolPlugins.delete(name);
      this.serverResources.delete(name);
      this.serverPrompts.delete(name);
      this.serverSkills.delete(name);
      this.notifyToolsChanged(name);
    }
  }

  /** Enable a previously-disabled server and connect to it. */
  async enableServer(name: string): Promise<void> {
    // Load the config to find the server
    const allConfigs = loadEnabledMcpConfigs(this.cwd);
    let config = allConfigs[name];

    if (!config) {
      // Maybe it's disabled — load raw configs to find it
      const { loadMcpConfigs } = await import('./config-loader.js');
      const rawConfigs = loadMcpConfigs(this.cwd);
      config = rawConfigs[name];
    }

    if (!config) return;

    // Remove disable marker
    enableServerConfig(name, config.scope, this.cwd);

    // Connect
    await this.connectAndDiscover(name, config);
  }

  /** Check if a server is currently disabled. */
  isServerDisabled(name: string): boolean {
    const conn = this.connections.get(name);
    return conn?.type === 'disabled';
  }

  /** Get all disabled server names. */
  getDisabledServerNames(): string[] {
    const names: string[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.type === 'disabled') names.push(name);
    }
    return names;
  }

  // ── Tool access ────────────────────────────────────────────────────

  getToolPlugins(): ToolPlugin[] {
    const all: ToolPlugin[] = [];
    for (const plugins of this.toolPlugins.values()) {
      all.push(...plugins);
    }
    return all;
  }

  getServerTools(serverName: string): ToolPlugin[] {
    return this.toolPlugins.get(serverName) ?? [];
  }

  /** Tool plugins for the given subset of servers (per-session enablement). */
  getToolsForServers(names: string[]): ToolPlugin[] {
    if (names.length === 0) return [];
    const wanted = new Set(names);
    const all: ToolPlugin[] = [];
    for (const [serverName, plugins] of this.toolPlugins) {
      if (wanted.has(serverName)) all.push(...plugins);
    }
    return all;
  }

  /**
   * All configured MCP servers (including disabled ones) with their live
   * connection status and tool count, for the picker UI.
   */
  listAllServers(): McpServerStatus[] {
    const all = loadMcpConfigs(this.cwd);
    const result: McpServerStatus[] = [];
    for (const [name, config] of Object.entries(all)) {
      const conn = this.connections.get(name);
      let status: McpServerStatus['status'];
      if (conn) {
        status = conn.type;
      } else if (isServerDisabled(name, config.scope, this.cwd)) {
        status = 'disabled';
      } else {
        status = 'unconnected';
      }

      let transport: Transport;
      let endpoint: string;
      let secretEnv: string[] = [];
      if ('command' in config) {
        transport = config.type ?? 'stdio';
        endpoint = [config.command, ...(config.args ?? [])].join(' ');
        secretEnv = Array.isArray(config.secretEnv) ? config.secretEnv : [];
      } else {
        transport = config.type;
        endpoint = config.url ?? '';
      }
      const secrets = getServerSecrets(name);
      const secretsSet = secretEnv.length === 0 || secretEnv.every((key) => Boolean(secrets[key]));

      result.push({
        name,
        scope: config.scope,
        status,
        toolCount: this.toolPlugins.get(name)?.length ?? 0,
        transport,
        endpoint,
        disabled: status === 'disabled',
        removed: isServerRemoved(name, config.scope, this.cwd),
        secretEnv,
        secretsSet,
        meta: getCatalogMeta(name),
      });
    }
    return result;
  }

  // ── Connection status ──────────────────────────────────────────────

  getConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  getConnectedServerNames(): string[] {
    const names: string[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.type === 'connected') names.push(name);
    }
    return names;
  }

  getFailedServerNames(): string[] {
    const names: string[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.type === 'failed') names.push(name);
    }
    return names;
  }

  getReconnectAttempts(name: string): number {
    return this.reconnectAttempts.get(name) ?? 0;
  }

  get totalToolCount(): number {
    let count = 0;
    for (const plugins of this.toolPlugins.values()) {
      count += plugins.length;
    }
    return count;
  }

  // ── Resources & Skills ─────────────────────────────────────────────

  /** Get all resources exposed by MCP servers. */
  getAllResources(): ServerResource[] {
    const all: ServerResource[] = [];
    for (const resources of this.serverResources.values()) {
      all.push(...resources);
    }
    return all;
  }

  /** Get resources for a specific server. */
  getServerResources(name: string): ServerResource[] {
    return this.serverResources.get(name) ?? [];
  }

  /** Get all MCP skills discovered across all servers. */
  getAllSkills(): McpSkill[] {
    const all: McpSkill[] = [];
    for (const skills of this.serverSkills.values()) {
      all.push(...skills);
    }
    return all;
  }

  /** Get skills for a specific server. */
  getServerSkills(name: string): McpSkill[] {
    return this.serverSkills.get(name) ?? [];
  }

  // ── Prompts ─────────────────────────────────────────────────────────

  /** Get all prompt templates discovered across all servers. */
  getAllPrompts(): McpPrompt[] {
    const all: McpPrompt[] = [];
    for (const prompts of this.serverPrompts.values()) {
      all.push(...prompts);
    }
    return all;
  }

  /** Get prompts for a specific server. */
  getServerPrompts(name: string): McpPrompt[] {
    return this.serverPrompts.get(name) ?? [];
  }

  /** Fetch a rendered prompt (`prompts/get`) from a connected server. */
  async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string> = {},
  ): Promise<GetPromptResult | null> {
    const conn = this.connections.get(serverName);
    if (conn?.type !== 'connected') return null;
    return getPrompt(conn, promptName, args);
  }

  // ── Auth ────────────────────────────────────────────────────────────

  /** Names of servers waiting for the user to complete OAuth authorization. */
  getNeedsAuthServerNames(): string[] {
    const names: string[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.type === 'needs-auth') names.push(name);
    }
    return names;
  }

  /** The authorization URL a `needs-auth` server is waiting on, if known. */
  getAuthorizationUrl(name: string): string | undefined {
    const conn = this.connections.get(name);
    return conn?.type === 'needs-auth' ? conn.authorizationUrl : undefined;
  }

  /** Get ToolPlugin wrappers for MCP resource operations. */
  getResourcePlugins(): ToolPlugin[] {
    return [
      createListMcpResourcesPlugin(this),
      createReadMcpResourcePlugin(this),
    ];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async disconnectServer(name: string): Promise<void> {
    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }

    const conn = this.connections.get(name);
    if (!conn) return;

    if (conn.type === 'connected') {
      try { await conn.cleanup(); } catch { /* ignore */ }
    }

    this.connections.delete(name);
    this.toolPlugins.delete(name);
    this.serverResources.delete(name);
    this.serverPrompts.delete(name);
    this.serverSkills.delete(name);
    this.reconnectAttempts.delete(name);
  }

  async shutdown(): Promise<void> {
    // Cancel all pending reconnects
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    const names = [...this.connections.keys()];
    await Promise.all(names.map((n) => this.disconnectServer(n)));
    this.initialized = false;
  }
}

// ── Convenience exports ──────────────────────────────────────────────────

export { loadEnabledMcpConfigs, hasMcpConfig } from './config-loader.js';
