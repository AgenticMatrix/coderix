/**
 * MCP secrets store — round-trip, permissions, deletion.
 * `homedir()` is mocked so ~/.coderix is never touched.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome };
});

const {
  mcpSecretsPath,
  getSecret,
  setSecret,
  getServerSecrets,
  clearServerSecrets,
  listServersWithSecrets,
} = await import('../../packages/coderix-core/src/mcp/secrets.js');

describe('MCP secrets store', () => {
  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), 'coderix-secrets-'));
  });

  afterEach(() => {
    rmSync(mockHome, { recursive: true, force: true });
  });

  it('stores secrets under ~/.coderix/mcp/secrets.json', () => {
    expect(mcpSecretsPath()).toBe(join(mockHome, '.coderix', 'mcp', 'secrets.json'));
  });

  it('round-trips a secret and persists it with 0600', () => {
    setSecret('github', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghp_abc');

    expect(getSecret('github', 'GITHUB_PERSONAL_ACCESS_TOKEN')).toBe('ghp_abc');
    expect(getServerSecrets('github')).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abc' });

    const mode = statSync(mcpSecretsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('isolates secrets by server', () => {
    setSecret('a', 'K', '1');
    setSecret('b', 'K', '2');
    expect(getSecret('a', 'K')).toBe('1');
    expect(getSecret('b', 'K')).toBe('2');
    expect(getServerSecrets('missing')).toEqual({});
  });

  it('deletes a single secret when set to an empty string', () => {
    setSecret('a', 'K', '1');
    setSecret('a', 'K', '');
    expect(getSecret('a', 'K')).toBeUndefined();
  });

  it('removes the file when the last secret is cleared', () => {
    setSecret('a', 'K', '1');
    expect(existsSync(mcpSecretsPath())).toBe(true);

    expect(clearServerSecrets('a')).toBe(true);
    expect(existsSync(mcpSecretsPath())).toBe(false);
    expect(clearServerSecrets('a')).toBe(false);
  });

  it('lists servers that have secrets', () => {
    setSecret('a', 'K', '1');
    setSecret('b', 'K', '2');
    expect(listServersWithSecrets().sort()).toEqual(['a', 'b']);
  });
});
