/**
 * McpManager integration — loads a real stdio server from disk config,
 * connects, and discovers tools + prompts. Exercises the config loader,
 * connection, discovery and prompt APIs together.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let mockHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome };
});

const { McpManager } = await import('../../packages/coderix-core/src/mcp/manager.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '../../examples/mcp/demo-server.mjs');

describe('McpManager (integration)', () => {
  let cwd: string;

  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), 'coderix-mcp-int-'));
    cwd = mockHome;
    mkdirSync(join(cwd, '.coderix'), { recursive: true });
    writeFileSync(
      join(cwd, '.coderix', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          demo: { type: 'stdio', command: process.execPath, args: [SERVER] },
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(mockHome, { recursive: true, force: true });
  });

  it('connects, discovers tools and prompts, and renders a prompt', async () => {
    const manager = new McpManager(cwd);
    try {
      await manager.initialize();

      expect(manager.getConnectedServerNames()).toContain('demo');
      expect(manager.getServerTools('demo')).toHaveLength(4);
      expect(manager.getAllPrompts().map((p) => p.name)).toEqual(
        expect.arrayContaining(['greet', 'summarize']),
      );

      const result = await manager.getPrompt('demo', 'greet', { name: 'Ada' });
      expect(JSON.stringify(result?.messages)).toContain('Ada');
    } finally {
      await manager.shutdown();
    }
  }, 20_000);
});
