/**
 * resolveServerEnv — merging stored/ambient secrets into a stdio server's env.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome };
});

const { resolveServerEnv } = await import('../../packages/coderix-core/src/mcp/connection.js');
const { setSecret } = await import('../../packages/coderix-core/src/mcp/secrets.js');
type ScopedServerConfig = import('../../packages/coderix-core/src/mcp/types.js').ScopedServerConfig;

function stdio(extra: Record<string, unknown> = {}): ScopedServerConfig {
  return { type: 'stdio', command: 'node', args: [], scope: 'user', ...extra } as ScopedServerConfig;
}

describe('resolveServerEnv', () => {
  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), 'coderix-resolve-'));
  });

  afterEach(() => {
    rmSync(mockHome, { recursive: true, force: true });
  });

  it('returns the config untouched when there is no secretEnv', () => {
    const config = stdio();
    expect(resolveServerEnv('svc', config)).toBe(config);
  });

  it('does not inject secrets for non-stdio servers', () => {
    const config = { type: 'http', url: 'https://x', scope: 'user', secretEnv: ['K'] } as ScopedServerConfig;
    expect(resolveServerEnv('svc', config)).toBe(config);
  });

  it('merges a stored secret into env', () => {
    setSecret('svc', 'API_KEY', 'stored-value');
    const config = stdio({ secretEnv: ['API_KEY'] });
    const resolved = resolveServerEnv('svc', config);
    expect(resolved).toMatchObject({ env: { API_KEY: 'stored-value' } });
  });

  it('falls back to the ambient environment variable', () => {
    process.env.TEST_MCP_KEY = 'from-env';
    try {
      const config = stdio({ secretEnv: ['TEST_MCP_KEY'] });
      const resolved = resolveServerEnv('svc', config);
      expect(resolved).toMatchObject({ env: { TEST_MCP_KEY: 'from-env' } });
    } finally {
      delete process.env.TEST_MCP_KEY;
    }
  });

  it('prefers the stored secret over the ambient environment', () => {
    process.env.TEST_MCP_KEY = 'from-env';
    setSecret('svc', 'TEST_MCP_KEY', 'from-store');
    try {
      const config = stdio({ secretEnv: ['TEST_MCP_KEY'] });
      expect(resolveServerEnv('svc', config)).toMatchObject({ env: { TEST_MCP_KEY: 'from-store' } });
    } finally {
      delete process.env.TEST_MCP_KEY;
    }
  });

  it('preserves literal env entries alongside merged secrets', () => {
    setSecret('svc', 'API_KEY', 'v');
    const config = stdio({ env: { FLAG: '1' }, secretEnv: ['API_KEY', 'MISSING'] });
    const resolved = resolveServerEnv('svc', config);
    expect(resolved).toMatchObject({ env: { FLAG: '1', API_KEY: 'v' } });
    expect('MISSING' in ((resolved as { env?: Record<string, string> }).env ?? {})).toBe(false);
  });
});
