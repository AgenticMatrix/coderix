/**
 * manager.test.ts — Integration tests for HookManager
 *
 * Tests:
 *  - Fast-path (no hooks) returns defaults
 *  - Hook execution via ScriptProvider
 *  - PreToolUse blocking
 *  - onPermissionRequest override
 *  - Fail-open behavior when hook script crashes
 *  - Match filtering (toolName)
 */

import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookManager } from '../manager.js';

const TEST_DIR = join(tmpdir(), 'coderagent-hook-mgr-' + Date.now());

function writeHookFile(dir: string, hooks: unknown[]): string {
  const filepath = join(dir, 'hooks.json');
  writeFileSync(filepath, JSON.stringify({ hooks }, null, 2));
  return filepath;
}

function jsonEcho(obj: Record<string, unknown>): string {
  return `node -e 'process.stdout.write(JSON.stringify(${JSON.stringify(obj)}))'`;
}

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('HookManager — fast path (no hooks)', () => {
  const mgr = new HookManager({
    globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
    projectConfigPath: join(TEST_DIR, 'also-nonexistent.json'),
    autoLoad: true,
  });

  it('onPreToolUse returns blocked:false when no hooks', async () => {
    const r = await mgr.onPreToolUse('s1', '/tmp', 'Bash', { command: 'ls' });
    expect(r).toEqual({ blocked: false });
  });

  it('onPermissionRequest returns {} when no hooks', async () => {
    const r = await mgr.onPermissionRequest('s1', '/tmp', 'Bash', {}, 'high', 'deny');
    expect(r).toEqual({});
  });

  it('onStop returns shouldStop:false when no hooks', async () => {
    const r = await mgr.onStop('s1', '/tmp', 5);
    expect(r).toEqual({ shouldStop: false });
  });

  it('onPreCompact returns empty injectContext when no hooks', async () => {
    const r = await mgr.onPreCompact('s1', '/tmp', 100, 50000, 100000, 'snip');
    expect(r).toEqual({ injectContext: '' });
  });

  it('onUserPromptSubmit returns blocked:false when no hooks', async () => {
    const r = await mgr.onUserPromptSubmit('s1', '/tmp', 'hello');
    expect(r).toEqual({ blocked: false });
  });

  it('void methods do not throw when no hooks', async () => {
    await expect(mgr.onSetup('s1', '/tmp')).resolves.toBeUndefined();
    await expect(mgr.onPostToolUse('s1', '/tmp', 'Bash', {}, { output: 'ok', success: true }, true, 100)).resolves.toBeUndefined();
    await expect(mgr.onNotification('s1', '/tmp', 'info', 'test')).resolves.toBeUndefined();
  });
});

describe('HookManager — hook execution', () => {
  it('PreToolUse hook can block a tool', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      {
        event: 'PreToolUse',
        command: jsonEcho({ blocked: true, reason: 'Dangerous command detected' }),
      },
    ]);

    const mgr = new HookManager({
      projectConfigPath: join(TEST_DIR, 'hooks.json'),
      globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
      autoLoad: true,
    });

    const r = await mgr.onPreToolUse('s1', '/tmp', 'Bash', { command: 'rm -rf /' });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('Dangerous');
  });

  it('PreToolUse hook with match toolName filter only fires for matching tool', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      {
        event: 'PreToolUse',
        command: jsonEcho({ blocked: true, reason: 'Only Bash' }),
        match: { toolName: 'Bash' },
      },
    ]);

    const mgr = new HookManager({
      projectConfigPath: join(TEST_DIR, 'hooks.json'),
      globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
      autoLoad: true,
    });

    // Should block Bash
    const r1 = await mgr.onPreToolUse('s1', '/tmp', 'Bash', { command: 'ls' });
    expect(r1.blocked).toBe(true);

    // Should NOT block Read (doesn't match filter)
    const r2 = await mgr.onPreToolUse('s1', '/tmp', 'Read', { file_path: '/tmp/x' });
    expect(r2.blocked).toBe(false);
  });

  it('onPermissionRequest hook can auto-approve', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      {
        event: 'onPermissionRequest',
        command: jsonEcho({ permissionOverride: 'auto-approve' }),
      },
    ]);

    const mgr = new HookManager({
      projectConfigPath: join(TEST_DIR, 'hooks.json'),
      globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
      autoLoad: true,
    });

    const r = await mgr.onPermissionRequest('s1', '/tmp', 'Bash', { command: 'ls' }, 'low', 'ask');
    expect(r.permissionOverride).toBe('auto-approve');
  });

  it('fail-open: crashing hook does not block the flow', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      {
        event: 'PreToolUse',
        command: 'node -e \'throw new Error("boom")\'', // crashes
      },
    ]);

    const mgr = new HookManager({
      projectConfigPath: join(TEST_DIR, 'hooks.json'),
      globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
      autoLoad: true,
    });

    // Should NOT throw, should return default permissive result
    const r = await mgr.onPreToolUse('s1', '/tmp', 'Bash', { command: 'ls' });
    expect(r.blocked).toBe(false);
  });

  it('onStop hook can trigger stop', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      {
        event: 'onStop',
        command: jsonEcho({ shouldStop: true }),
      },
    ]);

    const mgr = new HookManager({
      projectConfigPath: join(TEST_DIR, 'hooks.json'),
      globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
      autoLoad: true,
    });

    const r = await mgr.onStop('s1', '/tmp', 10);
    expect(r.shouldStop).toBe(true);
  });

  it('onPreCompact can inject context', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeHookFile(TEST_DIR, [
      {
        event: 'onPreCompact',
        command: jsonEcho({ injectContext: 'IMPORTANT: do not delete the config file' }),
      },
    ]);

    const mgr = new HookManager({
      projectConfigPath: join(TEST_DIR, 'hooks.json'),
      globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
      autoLoad: true,
    });

    const r = await mgr.onPreCompact('s1', '/tmp', 100, 50000, 100000, 'snip');
    expect(r.injectContext).toContain('IMPORTANT');
  });

  it('reload picks up new hooks', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const filepath = writeHookFile(TEST_DIR, [
      { event: 'onStop', command: jsonEcho({ shouldStop: false }) },
    ]);

    const mgr = new HookManager({
      projectConfigPath: filepath,
      globalConfigPath: join(TEST_DIR, 'nonexistent.json'),
      autoLoad: true,
    });

    // Initially returns false
    const r1 = await mgr.onStop('s1', '/tmp', 5);
    expect(r1.shouldStop).toBe(false);

    // Update config to block
    writeHookFile(TEST_DIR, [
      { event: 'onStop', command: jsonEcho({ shouldStop: true }) },
    ]);
    mgr.reload();

    const r2 = await mgr.onStop('s1', '/tmp', 5);
    expect(r2.shouldStop).toBe(true);
  });
});
