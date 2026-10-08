/**
 * MCP OAuth — FileOAuthProvider persistence tests.
 *
 * `homedir()` is mocked to a temp dir so the real ~/.coderix is never touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome };
});

const { FileOAuthProvider, createOAuthProvider, clearOAuthCredentials, mcpAuthStorePath } =
  await import('../../packages/coderix-core/src/mcp/oauth.js');

const TOKENS = { access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1', expires_in: 3600 };

describe('FileOAuthProvider', () => {
  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), 'coderix-oauth-'));
  });

  afterEach(() => {
    rmSync(mockHome, { recursive: true, force: true });
  });

  it('stores the credential file under ~/.coderix', () => {
    expect(mcpAuthStorePath()).toBe(join(mockHome, '.coderix', 'mcp-auth.json'));
  });

  it('persists tokens to disk and reads them back on a new instance', () => {
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' });
    provider.saveTokens(TOKENS as never);

    expect(existsSync(mcpAuthStorePath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(mcpAuthStorePath(), 'utf-8'));
    expect(onDisk.srv.tokens.access_token).toBe('at-1');

    const reopened = new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' });
    expect(reopened.tokens()).toMatchObject({ access_token: 'at-1' });
  });

  it('round-trips the PKCE code verifier', () => {
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' });
    provider.saveCodeVerifier('verifier-123');
    expect(provider.codeVerifier()).toBe('verifier-123');
  });

  it('uses static client credentials from config when provided', () => {
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', {
      type: 'authorization_code',
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(provider.clientInformation()).toEqual({ client_id: 'cid', client_secret: 'secret' });
  });

  it('reads dynamically-registered client information when no static id is set', () => {
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' });
    expect(provider.clientInformation()).toBeUndefined();
    provider.saveClientInformation({ client_id: 'dyn' } as never);
    expect(provider.clientInformation()).toEqual({ client_id: 'dyn' });
  });

  it('builds a loopback redirect URL from the configured port', () => {
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', {
      type: 'authorization_code',
      callbackPort: 8899,
    });
    expect(provider.redirectUrl).toBe('http://localhost:8899/callback');
  });

  it('advertises the authorization-code metadata', () => {
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' });
    expect(provider.clientMetadata.grant_types).toContain('authorization_code');
    expect(provider.clientMetadata.response_types).toEqual(['code']);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none');
  });

  it('reports the authorization URL instead of opening a browser', () => {
    const seen: string[] = [];
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' }, {
      openUrl: () => {},
      onAuthorizationRequired: (url) => seen.push(url),
    });
    provider.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'));
    expect(provider.authorizationUrl).toBe('https://auth.example/authorize?x=1');
    expect(seen).toEqual(['https://auth.example/authorize?x=1']);
  });

  it('clears credentials', () => {
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' });
    provider.saveTokens(TOKENS as never);
    expect(clearOAuthCredentials('srv')).toBe(true);
    expect(new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' }).tokens()).toBeUndefined();
    expect(clearOAuthCredentials('srv')).toBe(false);
  });

  it('invalidates a single credential scope', () => {
    const provider = new FileOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' });
    provider.saveTokens(TOKENS as never);
    provider.saveCodeVerifier('v');
    provider.invalidateCredentials('tokens');
    expect(provider.tokens()).toBeUndefined();
    expect(provider.codeVerifier()).toBe('v');
  });
});

describe('createOAuthProvider', () => {
  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), 'coderix-oauth-'));
  });
  afterEach(() => {
    rmSync(mockHome, { recursive: true, force: true });
  });

  it('returns a FileOAuthProvider for the authorization-code flow', () => {
    const provider = createOAuthProvider('srv', 'https://x/mcp', { type: 'authorization_code' });
    expect(provider).toBeInstanceOf(FileOAuthProvider);
  });

  it('requires credentials for client_credentials', () => {
    expect(() => createOAuthProvider('srv', 'https://x/mcp', { type: 'client_credentials' })).toThrow();
    const provider = createOAuthProvider('srv', 'https://x/mcp', {
      type: 'client_credentials',
      clientId: 'cid',
      clientSecret: 'secret',
    });
    expect(provider.redirectUrl).toBeUndefined();
  });
});
