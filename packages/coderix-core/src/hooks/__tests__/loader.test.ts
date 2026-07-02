/**
 * loader.test.ts — Tests for HookLoader (config discovery + indexing)
 */

import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookLoader } from '../loader.js';

const TEST_DIR = join(tmpdir(), 'coderix-hook-test-' + Date.now());

function writeHookFile(dir: string, hooks: unknown[]): string {
  const filepath = join(dir, 'hooks.json');
  writeFileSync(filepath, JSON.stringify({ hooks }, null, 2));
  return filepath;
}

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('HookLoader', () => {
  it('should return empty array when no config exists', () => {
    const loader = new HookLoader({
      globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
      projectConfigPath: join(TEST_DIR, 'also-nonexistent.json'),
    });
    loader.load();
    expect(loader.totalCount()).toBe(0);
    expect(loader.getForEvent('PreToolUse')).toEqual([]);
  });

  it('should load hooks from a single config file', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      { event: 'PreToolUse', command: 'echo test' },
      { event: 'onStop', command: 'node cleanup.js' },
    ]);

    const loader = new HookLoader({
      globalConfigPath: join(TEST_DIR, 'hooks.json'),
      projectConfigPath: join(TEST_DIR, 'nonexistent.json'),
    });
    loader.load();

    expect(loader.totalCount()).toBe(2);
    expect(loader.getForEvent('PreToolUse')).toHaveLength(1);
    expect(loader.getForEvent('onStop')).toHaveLength(1);
    expect(loader.getForEvent('onNotification')).toEqual([]);
  });

  it('should merge global and project hooks (project first)', () => {
    const globalDir = join(TEST_DIR, 'global');
    const projectDir = join(TEST_DIR, 'project');
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeHookFile(globalDir, [
      { event: 'PreToolUse', command: 'global-hook' },
    ]);
    writeHookFile(projectDir, [
      { event: 'PreToolUse', command: 'project-hook' },
    ]);

    const loader = new HookLoader({
      globalConfigPath: join(globalDir, 'hooks.json'),
      projectConfigPath: join(projectDir, 'hooks.json'),
    });
    loader.load();

    const hooks = loader.getForEvent('PreToolUse');
    expect(hooks).toHaveLength(2);
    // Project hooks should come FIRST
    expect(hooks[0].command).toBe('project-hook');
    expect(hooks[1].command).toBe('global-hook');
  });

  it('should skip malformed JSON silently', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, 'hooks.json'), '{ not valid json }}}');
    const loader = new HookLoader({
      globalConfigPath: join(TEST_DIR, 'hooks.json'),
      projectConfigPath: join(TEST_DIR, 'nonexistent.json'),
    });
    // Should not throw
    expect(() => loader.load()).not.toThrow();
    expect(loader.totalCount()).toBe(0);
  });

  it('should skip entries with missing event or command', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      { event: 'PreToolUse' },                    // missing command
      { command: 'echo hi' },                     // missing event
      { event: 'onStop', command: 'echo ok' },   // valid
      {},                                        // missing both
    ]);

    const loader = new HookLoader({
      globalConfigPath: join(TEST_DIR, 'hooks.json'),
      projectConfigPath: join(TEST_DIR, 'nonexistent.json'),
    });
    loader.load();

    expect(loader.totalCount()).toBe(1);
    expect(loader.getForEvent('onStop')).toHaveLength(1);
  });

  it('should index hooks by event type', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      { event: 'PreToolUse', command: 'a' },
      { event: 'PostToolUse', command: 'b' },
      { event: 'PreToolUse', command: 'c' },
      { event: 'onStop', command: 'd' },
    ]);

    const loader = new HookLoader({
      globalConfigPath: join(TEST_DIR, 'hooks.json'),
      projectConfigPath: join(TEST_DIR, 'nonexistent.json'),
    });
    loader.load();

    expect(loader.getForEvent('PreToolUse')).toHaveLength(2);
    expect(loader.getForEvent('PostToolUse')).toHaveLength(1);
    expect(loader.getForEvent('onStop')).toHaveLength(1);
    expect(loader.getForEvent('onNotification')).toEqual([]);
  });

  it('should support reload', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filepath = writeHookFile(TEST_DIR, [
      { event: 'PreToolUse', command: 'v1' },
    ]);

    const loader = new HookLoader({
      globalConfigPath: filepath,
      projectConfigPath: join(TEST_DIR, 'nonexistent.json'),
    });
    loader.load();
    expect(loader.totalCount()).toBe(1);

    // Change the config
    writeHookFile(TEST_DIR, [
      { event: 'PreToolUse', command: 'v2' },
      { event: 'onStop', command: 'stop' },
    ]);

    loader.reload();
    expect(loader.totalCount()).toBe(2);
    expect(loader.getForEvent('PreToolUse')[0].command).toBe('v2');
  });
});
