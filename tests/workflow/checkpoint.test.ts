/**
 * Tests for CheckpointManager — resume / replay of workflow agent calls.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { CheckpointManager } from '../../src/workflow/checkpoint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CACHE_DIR = join(homedir(), '.coderix', 'workflow-cache');

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function cleanupCache(scriptHash: string): void {
  const filePath = join(CACHE_DIR, `${scriptHash}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CheckpointManager', () => {
  afterEach(() => {
    // Clean up test cache files
    try {
      if (existsSync(CACHE_DIR)) {
        const files = readdirSync(CACHE_DIR);
        for (const file of files) {
          if (file.endsWith('.json')) {
            unlinkSync(join(CACHE_DIR, file));
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should return null on cache miss (first run)', () => {
    const cp = new CheckpointManager('const script1 = "v1";', { key: 'val' });

    const result = cp.get('do something');
    expect(result).toBeNull();
    expect(cp.currentCallIndex).toBe(0);
  });

  it('should cache and retrieve results', () => {
    const script = 'const s = "test script";';
    const args = { target: 'src/app.ts' };

    const cp1 = new CheckpointManager(script, args);
    expect(cp1.get('prompt-1')).toBeNull();

    cp1.set('prompt-1', 'result-1');
    cp1.save();

    // New manager with same script + args should hit cache
    const cp2 = new CheckpointManager(script, args);
    const cached = cp2.get('prompt-1');
    expect(cached).toBe('result-1');
    expect(cp2.currentCallIndex).toBe(1);
  });

  it('should NOT hit cache when script differs', () => {
    const args = { key: 'val' };

    const cp1 = new CheckpointManager('script version 1', args);
    cp1.set('prompt-x', 'result-x');
    cp1.save();

    const cp2 = new CheckpointManager('script version 2 - changed!', args);
    const cached = cp2.get('prompt-x');
    expect(cached).toBeNull();
  });

  it('should NOT hit cache when args differ', () => {
    const script = 'same script';

    const cp1 = new CheckpointManager(script, { version: 1 });
    cp1.set('prompt-y', 'result-y');
    cp1.save();

    const cp2 = new CheckpointManager(script, { version: 2 });
    const cached = cp2.get('prompt-y');
    expect(cached).toBeNull();
  });

  it('should invalidate subsequent entries when a call changes', () => {
    const script = 'multi-call script';
    const args = {};

    // First run: 3 agent calls
    const cp1 = new CheckpointManager(script, args);
    cp1.set('step-1', 'result-1');
    cp1.set('step-2', 'result-2');
    cp1.set('step-3', 'result-3');
    cp1.save();

    // Second run: step-2 prompt changed → step-2 and step-3 invalidated
    const cp2 = new CheckpointManager(script, args);
    const cached1 = cp2.get('step-1'); // should hit cache
    expect(cached1).toBe('result-1');

    const cached2 = cp2.get('step-2-CHANGED'); // different prompt → miss
    expect(cached2).toBeNull();

    const cached3 = cp2.get('step-3'); // should be invalidated
    expect(cached3).toBeNull();

    // Cache file should only contain step-1 now
    cp2.set('step-2-CHANGED', 'result-2-new');
    cp2.save();

    const cp3 = new CheckpointManager(script, args);
    expect(cp3.get('step-1')).toBe('result-1');
    expect(cp3.get('step-2-CHANGED')).toBe('result-2-new');
    expect(cp3.get('step-3')).toBeNull();
  });

  it('should advance call index correctly', () => {
    const cp = new CheckpointManager('index test', {});

    expect(cp.currentCallIndex).toBe(0);

    cp.set('p1', 'r1');
    expect(cp.currentCallIndex).toBe(1);

    cp.set('p2', 'r2');
    expect(cp.currentCallIndex).toBe(2);

    cp.set('p3', 'r3');
    expect(cp.currentCallIndex).toBe(3);
  });

  it('should handle empty script', () => {
    const cp = new CheckpointManager('', {});
    expect(cp.currentCallIndex).toBe(0);
    expect(cp.get('any')).toBeNull();
    cp.set('any', 'value');
    expect(cp.currentCallIndex).toBe(1);
  });

  it('should handle undefined args', () => {
    const cp1 = new CheckpointManager('script', undefined);
    cp1.set('p', 'r');
    cp1.save();

    const cp2 = new CheckpointManager('script');
    expect(cp2.get('p')).toBe('r');
  });

  it('should persist and reload across instances', () => {
    const script = 'persistence test';
    const args = { depth: 5 };

    const cp1 = new CheckpointManager(script, args);
    cp1.set('find bugs', 'found 3 bugs');
    cp1.set('fix bugs', 'all fixed');
    cp1.save();

    // Verify the cache file exists
    const scriptHash = hashString(script + JSON.stringify(args));
    const cachePath = join(CACHE_DIR, `${scriptHash}.json`);
    expect(existsSync(cachePath)).toBe(true);

    // New instance loads the cache
    const cp2 = new CheckpointManager(script, args);
    expect(cp2.get('find bugs')).toBe('found 3 bugs');
    expect(cp2.get('fix bugs')).toBe('all fixed');
  });
});
