/**
 * MCP connection — establishes and tears down connections to MCP servers.
 *
 * Uses the official @modelcontextprotocol/sdk for transport implementations.
 * Supports stdio (subprocess), Streamable HTTP and SSE transports, plus OAuth
 * for remote servers.
 *
 * Responsibilities beyond the SDK:
 *  - register `*_list_changed` notification handlers (hot reload)
 *  - watch for mid-session connection drops so the manager can reconnect
 *  - translate `UnauthorizedError` into a `needs-auth` state carrying the URL
 *    the user must open
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  ListRootsRequestSchema,
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
  ConnectedServer,
  ScopedServerConfig,
  ServerConnection,
} from './types.js';
import { createOAuthProvider, openUrlInBrowser } from './oauth.js';
import { getServerSecrets } from './secrets.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Default timeout for establishing a connection (30s). */
export const CONNECT_TIMEOUT_MS = 30_000;

// ── Hooks ──────────────────────────────────────────────────────────────

/** Callbacks the manager registers to react to server-initiated changes. */
export interface ConnectHooks {
  /** Server announced its tool list changed (`tools/list_changed`). */
  onToolsListChanged?: () => void;
  /** Server announced its resource list changed (`resources/list_changed`). */
  onResourcesListChanged?: () => void;
  /** Server announced its prompt list changed (`prompts/list_changed`). */
  onPromptsListChanged?: () => void;
  /** The connection dropped after a successful connect (not a clean close). */
  onConnectionLost?: (error?: Error) => void;
  /**
   * Whether to open the user's browser when OAuth authorization is required.
   * Defaults to false so background startup never pops a browser unexpectedly —
   * the authorization URL is still captured and surfaced as `needs-auth`.
   * `coderix mcp auth` sets this to true.
   */
  openAuthBrowser?: boolean;
}

/**
 * Overlay resolved secrets onto a stdio server's `env`.
 *
 * Each name in `config.secretEnv` is looked up first in the stored secrets
 * (`~/.coderix/mcp/secrets.json`), then in the ambient environment. Missing
 * values are skipped rather than injected as empty strings, so a server can
 * still start (and report its own auth error) when a key isn't set yet.
 */
export function resolveServerEnv(
  serverName: string,
  config: ScopedServerConfig,
): ScopedServerConfig {
  if (!('command' in config)) return config;
  const secretEnv = config.secretEnv ?? [];
  if (secretEnv.length === 0) return config;

  const stored = getServerSecrets(serverName);
  const env: Record<string, string> = { ...(config.env ?? {}) };
  for (const name of secretEnv) {
    const value = stored[name] ?? process.env[name];
    if (value) env[name] = value;
  }
  return { ...config, env };
}

// ── Transport factory ──────────────────────────────────────────────────

interface CreatedTransport {
  transport: Transport;
  authProvider?: OAuthClientProvider;
  /** Set by the provider when the user must open an authorization URL. */
  authUrlRef: { url?: string };
}

/**
 * Create the appropriate MCP Transport for a server config.
 * Returns null for unsupported transport types.
 */
function createTransport(
  name: string,
  config: ScopedServerConfig,
  openAuthBrowser = false,
): CreatedTransport | null {
  // Determine effective type: defaults to 'stdio' for process-based configs
  const effectiveType = config.type || 'stdio';
  const oauthOptions = {
    openUrl: openAuthBrowser ? openUrlInBrowser : () => {},
  };

  switch (effectiveType) {
    case 'stdio': {
      if (!('command' in config)) return null;
      return {
        transport: new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env as Record<string, string> | undefined,
          // 'pipe', never 'inherit': an inherited stderr writes straight to the
          // terminal while the TUI owns it, moving the cursor without ink's
          // knowledge. Ink's next repaint then rewinds to the wrong row and
          // strands the frame it meant to erase, stacking duplicate tool blocks
          // and status bars. `connectToServer` drains this pipe into
          // `console.error`, which ink patches and replays above its frame.
          stderr: 'pipe',
        }),
        authUrlRef: {},
      };
    }

    case 'http': {
      if (!('url' in config)) return null;
      const authUrlRef: { url?: string } = {};
      const authProvider =
        config.oauth &&
        createOAuthProvider(name, config.url, config.oauth, {
          ...oauthOptions,
          onAuthorizationRequired: (u) => {
            authUrlRef.url = u;
          },
        });
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers
            ? { headers: config.headers as Record<string, string> }
            : undefined,
          ...(authProvider ? { authProvider } : {}),
        }),
        authProvider: authProvider ?? undefined,
        authUrlRef,
      };
    }

    case 'sse': {
      if (!('url' in config)) return null;
      const authUrlRef: { url?: string } = {};
      const authProvider =
        config.oauth &&
        createOAuthProvider(name, config.url, config.oauth, {
          ...oauthOptions,
          onAuthorizationRequired: (u) => {
            authUrlRef.url = u;
          },
        });
      return {
        transport: new SSEClientTransport(new URL(config.url), {
          requestInit: config.headers
            ? { headers: config.headers as Record<string, string> }
            : undefined,
          ...(authProvider ? { authProvider } : {}),
        }),
        authProvider: authProvider ?? undefined,
        authUrlRef,
      };
    }

    default:
      return null;
  }
}

// ── Client creation ────────────────────────────────────────────────────

/**
 * Create a configured MCP Client with standard capabilities.
 * The client is NOT connected — call client.connect(transport) after.
 */
function createClient(name: string, cwd: string): Client {
  const client = new Client(
    {
      name: 'coderix',
      version: '0.1.0',
    },
    {
      capabilities: {
        roots: {},
      },
    },
  );

  // Handle ListRoots requests — tell the server our working directory
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: `file://${cwd}` }],
  }));

  return client;
}

/** Register `*_list_changed` notification handlers on a connected client. */
function installListChangedHandlers(client: Client, hooks: ConnectHooks): void {
  if (hooks.onToolsListChanged) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      hooks.onToolsListChanged?.();
    });
  }
  if (hooks.onResourcesListChanged) {
    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      hooks.onResourcesListChanged?.();
    });
  }
  if (hooks.onPromptsListChanged) {
    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      hooks.onPromptsListChanged?.();
    });
  }
}

/** Which primitives advertise `listChanged` in the server capabilities. */
function readListChanged(
  capabilities: ConnectedServer['capabilities'],
): ConnectedServer['listChanged'] {
  return {
    tools: capabilities?.tools?.listChanged ?? false,
    resources: capabilities?.resources?.listChanged ?? false,
    prompts: capabilities?.prompts?.listChanged ?? false,
  };
}

// ── Connection ─────────────────────────────────────────────────────────

/**
 * Connect to an MCP server and return the connection state.
 *
 * On success, returns a ConnectedServer with:
 *   - client: the connected MCP Client (for tool discovery & execution)
 *   - cleanup: a function to disconnect and release resources
 *
 * On failure, returns a FailedServer with error details; if the server
 * requires OAuth, returns a NeedsAuthServer carrying the authorization URL.
 */
export async function connectToServer(
  serverName: string,
  config: ScopedServerConfig,
  cwd: string,
  hooks: ConnectHooks = {},
): Promise<ServerConnection> {
  const effectiveConfig = resolveServerEnv(serverName, config);
  const created = createTransport(serverName, effectiveConfig, hooks.openAuthBrowser ?? false);

  if (!created) {
    return {
      name: serverName,
      type: 'failed',
      config,
      error: `Unsupported transport: ${config.type ?? 'stdio'} (missing command/url)`,
    };
  }

  const { transport, authUrlRef } = created;
  const client = createClient(serverName, cwd);
  let closedByUs = false;

  try {
    // Connect with timeout
    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      `Connection to "${serverName}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s`,
    );

    // Drain the subprocess's stderr through the patched console, so its
    // diagnostics reach the user without writing behind ink's back.
    const childErr = (transport as { stderr?: NodeJS.ReadableStream | null }).stderr;
    if (childErr) {
      childErr.on('data', (chunk: Buffer | string) => {
        const text = String(chunk).replace(/\n+$/, '');
        if (text) console.error(`[mcp:${serverName}] ${text}`);
      });
      // A server that dies noisily must not take the session with it.
      childErr.on('error', () => {});
    }

    // Hot reload: react to server-initiated list changes.
    installListChangedHandlers(client, hooks);

    // Mid-session drop detection: only reconnect for unclean closes.
    const originalOnClose = client.onclose;
    const originalOnError = client.onerror;
    client.onerror = (error: Error) => {
      originalOnError?.(error);
    };
    client.onclose = () => {
      originalOnClose?.();
      if (!closedByUs) hooks.onConnectionLost?.();
    };

    const capabilities = client.getServerCapabilities() ?? {};
    const version = client.getServerVersion();
    const serverInfo = version
      ? { name: version.name, version: version.version }
      : undefined;
    const instructions = client.getInstructions() ?? undefined;

    const cleanup = async () => {
      closedByUs = true;
      try {
        await client.close();
      } catch {
        // Best-effort cleanup
      }
    };

    return {
      name: serverName,
      type: 'connected',
      client,
      capabilities,
      serverInfo,
      instructions,
      config,
      cleanup,
      listChanged: readListChanged(capabilities),
    };
  } catch (err) {
    // Clean up partial connection
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }

    if (err instanceof UnauthorizedError || (err as Error)?.name === 'UnauthorizedError') {
      return {
        name: serverName,
        type: 'needs-auth',
        config,
        ...(authUrlRef.url ? { authorizationUrl: authUrlRef.url } : {}),
      };
    }

    return {
      name: serverName,
      type: 'failed',
      config,
      error: (err as Error).message,
    };
  }
}

// ── OAuth completion ───────────────────────────────────────────────────

export interface OAuthCompletionResult {
  ok: boolean;
  error?: string;
}

/**
 * Complete an authorization-code flow: hand the code from the redirect back to
 * a fresh transport (the PKCE verifier and client info are read from the file
 * store), then verify by reconnecting.
 */
export async function completeOAuthAuthorization(
  serverName: string,
  config: ScopedServerConfig,
  cwd: string,
  code: string,
): Promise<OAuthCompletionResult> {
  const created = createTransport(serverName, config);
  if (!created) {
    return { ok: false, error: `Unsupported transport for "${serverName}"` };
  }
  const transport = created.transport as Transport & {
    finishAuth?: (code: string) => Promise<void>;
  };
  if (typeof transport.finishAuth !== 'function') {
    return { ok: false, error: `Server "${serverName}" transport does not support OAuth` };
  }

  try {
    await transport.finishAuth(code);
  } catch (err) {
    return { ok: false, error: `Token exchange failed: ${(err as Error).message}` };
  }

  // Verify the tokens actually work by connecting.
  const conn = await connectToServer(serverName, config, cwd);
  if (conn.type === 'connected') {
    await conn.cleanup();
    return { ok: true };
  }
  return {
    ok: false,
    error:
      conn.type === 'needs-auth'
        ? 'Authorization still required — the server rejected the token'
        : conn.type === 'failed'
          ? conn.error
          : `Unexpected state: ${conn.type}`,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Check if two server configs match by signature (for dedup).
 * Returns null for configs that can't be compared.
 */
export function getServerSignature(config: ScopedServerConfig): string | null {
  if ('command' in config && config.command) {
    const parts = [config.command, ...(config.args ?? [])];
    return `stdio:${JSON.stringify(parts)}`;
  }
  if ('url' in config && config.url) {
    return `url:${config.url}`;
  }
  return null;
}
