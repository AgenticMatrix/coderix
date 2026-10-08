/**
 * MCP OAuth — file-backed OAuthClientProvider for remote (http/sse) servers.
 *
 * The official SDK drives discovery (RFC 9728 / RFC 8414), dynamic client
 * registration (RFC 7591) and the PKCE authorization-code exchange; this module
 * supplies the four things the SDK delegates to the host:
 *   1. token / client-info persistence (so auth survives restarts),
 *   2. the loopback redirect URL,
 *   3. opening the browser + remembering the authorization URL,
 *   4. reading back the code verifier when the user returns with a code.
 *
 * Credentials live in `~/.coderix/mcp-auth.json`, keyed by server name.
 * See also: https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js';

import type { McpOAuthConfig } from './types.js';

// ── Constants ──────────────────────────────────────────────────────────

export const DEFAULT_OAUTH_CALLBACK_PORT = 7777;

// ── Store ──────────────────────────────────────────────────────────────

interface OAuthCredentialEntry {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

type OAuthStore = Record<string, OAuthCredentialEntry>;

export function mcpAuthStorePath(): string {
  return join(homedir(), '.coderix', 'mcp-auth.json');
}

function readStore(): OAuthStore {
  const path = mcpAuthStorePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as OAuthStore;
  } catch {
    return {};
  }
}

function writeStore(store: OAuthStore): void {
  const path = mcpAuthStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort — some filesystems don't support chmod
  }
}

function updateEntry(
  serverName: string,
  patch: Partial<OAuthCredentialEntry>,
): void {
  const store = readStore();
  const entry = store[serverName] ?? {};
  store[serverName] = { ...entry, ...patch };
  writeStore(store);
}

/** Remove all stored OAuth credentials for a server. */
export function clearOAuthCredentials(serverName: string): boolean {
  const store = readStore();
  if (!(serverName in store)) return false;
  delete store[serverName];
  writeStore(store);
  return true;
}

// ── Browser ────────────────────────────────────────────────────────────

/**
 * Best-effort open of a URL in the user's default browser. Never throws —
 * the caller still prints the URL so a headless environment can copy it.
 */
export function openUrlInBrowser(url: string): void {
  const { command, args } =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] };

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore — the URL is printed by the caller regardless
  }
}

// ── Provider ───────────────────────────────────────────────────────────

export interface FileOAuthProviderOptions {
  /** Called when user interaction is required (before opening the browser). */
  onAuthorizationRequired?: (authorizationUrl: string) => void;
  /** Override browser opening (tests pass a no-op). */
  openUrl?: (url: string) => void;
}

/**
 * File-backed `OAuthClientProvider` for the authorization-code + PKCE flow.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private readonly serverName: string;
  private readonly serverUrl: string;
  private readonly config: McpOAuthConfig;
  private readonly options: FileOAuthProviderOptions;

  /** The most recent authorization URL handed to the user agent. */
  authorizationUrl?: string;

  constructor(
    serverName: string,
    serverUrl: string,
    config: McpOAuthConfig,
    options: FileOAuthProviderOptions = {},
  ) {
    this.serverName = serverName;
    this.serverUrl = serverUrl;
    this.config = config;
    this.options = options;
  }

  get redirectUrl(): string {
    const port = this.config.callbackPort ?? DEFAULT_OAUTH_CALLBACK_PORT;
    return `http://localhost:${port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: this.config.clientSecret ? 'client_secret_post' : 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Coderix',
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // Static credentials from config take precedence over dynamic registration.
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }
    return readStore()[this.serverName]?.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    updateEntry(this.serverName, { clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return readStore()[this.serverName]?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    updateEntry(this.serverName, { tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const url = authorizationUrl.toString();
    this.authorizationUrl = url;
    this.options.onAuthorizationRequired?.(url);
    (this.options.openUrl ?? openUrlInBrowser)(url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    updateEntry(this.serverName, { codeVerifier });
  }

  codeVerifier(): string {
    return readStore()[this.serverName]?.codeVerifier ?? '';
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    updateEntry(this.serverName, { discoveryState: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return readStore()[this.serverName]?.discoveryState;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      clearOAuthCredentials(this.serverName);
      return;
    }
    const patch: Partial<OAuthCredentialEntry> = {};
    if (scope === 'client') patch.clientInformation = undefined;
    if (scope === 'tokens') patch.tokens = undefined;
    if (scope === 'verifier') patch.codeVerifier = undefined;
    if (scope === 'discovery') patch.discoveryState = undefined;
    updateEntry(this.serverName, patch);
  }

  get url(): string {
    return this.serverUrl;
  }
}

/**
 * Create the right OAuth provider for a server's config.
 * - `client_credentials` → the SDK's non-interactive provider.
 * - `authorization_code` (default) → the file-backed interactive provider.
 */
export function createOAuthProvider(
  serverName: string,
  serverUrl: string,
  config: McpOAuthConfig,
  options: FileOAuthProviderOptions = {},
): OAuthClientProvider {
  if (config.type === 'client_credentials') {
    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        `MCP server "${serverName}": client_credentials requires clientId and clientSecret`,
      );
    }
    return new ClientCredentialsProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      clientName: 'Coderix',
      ...(config.scope ? { scope: config.scope } : {}),
    });
  }
  return new FileOAuthProvider(serverName, serverUrl, config, options);
}

/** True when a server config carries OAuth settings. */
export function hasOAuthConfig(config: { oauth?: McpOAuthConfig }): boolean {
  return !!config.oauth;
}
