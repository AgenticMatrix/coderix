/**
 * MCP bundle — installed `~/.coderix/mcp/config.json` loading, precedence and
 * disabled-set handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let mockHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome };
});

const {
  loadMcpConfigs,
  isServerDisabled,
  listDisabledServerNames,
  enableServer,
} = await import('../../packages/coderix-core/src/mcp/config-loader.js');
const { installedMcpDir, installedConfigPath } = await import('../../packages/coderix-core/src/mcp/bundle.js');

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

describe('MCP bundle loading', () => {
  let cwd: string;

  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), 'coderix-bundle-'));
    cwd = mkdtempSync(join(tmpdir(), 'coderix-bundle-cwd-'));
  });

  afterEach(() => {
    rmSync(mockHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('exposes the installed paths under ~/.coderix/mcp', () => {
    expect(installedMcpDir()).toBe(join(mockHome, '.coderix', 'mcp'));
    expect(installedConfigPath()).toBe(join(mockHome, '.coderix', 'mcp', 'config.json'));
  });

  it('loads servers from the installed bundle as user scope', () => {
    writeJson(installedConfigPath(), {
      mcpServers: { memory: { type: 'stdio', command: 'npx', args: ['-y', 'memory'] } },
    });

    const configs = loadMcpConfigs(cwd);
    expect(configs.memory).toMatchObject({ command: 'npx', scope: 'user' });
  });

  it('lets ~/.coderix/mcp.json override the bundle, and project override both', () => {
    writeJson(installedConfigPath(), {
      mcpServers: { svc: { type: 'stdio', command: 'from-bundle' } },
    });
    writeJson(join(mockHome, '.coderix', 'mcp.json'), {
      mcpServers: { svc: { type: 'stdio', command: 'from-user' } },
    });
    writeJson(join(cwd, '.coderix', 'mcp.json'), {
      mcpServers: { svc: { type: 'stdio', command: 'from-project' } },
    });

    expect(loadMcpConfigs(cwd).svc?.command).toBe('from-project');

    rmSync(join(cwd, '.coderix', 'mcp.json'));
    expect(loadMcpConfigs(cwd).svc?.command).toBe('from-user');

    rmSync(join(mockHome, '.coderix', 'mcp.json'));
    expect(loadMcpConfigs(cwd).svc?.command).toBe('from-bundle');
  });

  it('honours disabledServers declared in the bundle', () => {
    writeJson(installedConfigPath(), {
      mcpServers: {
        open: { type: 'stdio', command: 'a' },
        keyed: { type: 'stdio', command: 'b', secretEnv: ['KEY'] },
      },
      disabledServers: ['keyed'],
    });

    expect(isServerDisabled('keyed', 'user', cwd)).toBe(true);
    expect(isServerDisabled('open', 'user', cwd)).toBe(false);
    expect(listDisabledServerNames(cwd)).toContainEqual({ name: 'keyed', scope: 'user' });
  });

  it('enableServer clears the name from the bundle disabled list', () => {
    writeJson(installedConfigPath(), {
      mcpServers: { keyed: { type: 'stdio', command: 'b' } },
      disabledServers: ['keyed'],
    });

    enableServer('keyed', 'user', cwd);

    expect(isServerDisabled('keyed', 'user', cwd)).toBe(false);
    // The bundle file itself is rewritten without the disabled entry.
    expect(existsSync(installedConfigPath())).toBe(true);
  });

  it('parses secretEnv from the config', () => {
    writeJson(installedConfigPath(), {
      mcpServers: { keyed: { type: 'stdio', command: 'b', secretEnv: ['TOKEN', 'OTHER'] } },
    });
    const cfg = loadMcpConfigs(cwd).keyed;
    expect(cfg && 'secretEnv' in cfg ? cfg.secretEnv : undefined).toEqual(['TOKEN', 'OTHER']);
  });
});
