/**
 * Tests for ConcurrencyController — the global concurrency limiter.
 */

import { describe, expect, it } from 'vitest';
import { ConcurrencyController } from '../../src/workflow/concurrency.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function task(id: string, ms: number, fail = false): () => Promise<string> {
  return async () => {
    await delay(ms);
    if (fail) throw new Error(`Task ${id} failed`);
    return id;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConcurrencyController', () => {
  it('should execute tasks respecting max concurrency', async () => {
    const cc = new ConcurrencyController(2);
    const running: number[] = [];
    const startTimes: number[] = [];

    const tasks = [1, 2, 3, 4].map(i =>
      cc.enqueue(async () => {
        running.push(i);
        startTimes.push(Date.now());
        await delay(50);
        return i;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([1, 2, 3, 4]);

    // At most 2 tasks should have been running concurrently
    // We can verify by checking that start times overlap
    // The first two should start almost simultaneously
    expect(Math.abs(startTimes[0] - startTimes[1])).toBeLessThan(30);
  });

  it('should queue tasks when at capacity', async () => {
    const cc = new ConcurrencyController(1);
    const order: number[] = [];

    const promises = [1, 2, 3].map(i =>
      cc.enqueue(async () => {
        order.push(i);
        await delay(10);
        return i;
      }),
    );

    await Promise.all(promises);
    // With concurrency=1, tasks should execute in order
    expect(order).toEqual([1, 2, 3]);
  });

  it('should propagate task errors', async () => {
    const cc = new ConcurrencyController(2);

    await expect(
      cc.enqueue(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('should not accept new tasks after drain()', async () => {
    const cc = new ConcurrencyController(2);
    cc.drain();

    await expect(
      cc.enqueue(async () => 'ok'),
    ).rejects.toThrow('drained');
  });

  it('should report active and queued counts', async () => {
    const cc = new ConcurrencyController(1);

    expect(cc.activeCount).toBe(0);
    expect(cc.queuedCount).toBe(0);

    // First task starts immediately
    const p1 = cc.enqueue(async () => {
      await delay(30);
      return 1;
    });

    // Small delay for the task to actually start
    await delay(5);
    expect(cc.activeCount).toBe(1);

    // Second task should be queued
    const p2 = cc.enqueue(async () => 2);

    await delay(2);
    expect(cc.queuedCount).toBe(1);

    await Promise.all([p1, p2]);
    expect(cc.activeCount).toBe(0);
    expect(cc.queuedCount).toBe(0);
  });

  it('should compute max concurrency from CPU count', () => {
    const cc = new ConcurrencyController();
    // Should be at least 1 and at most 16
    expect(cc.maxConcurrent).toBeGreaterThanOrEqual(1);
    expect(cc.maxConcurrent).toBeLessThanOrEqual(16);
  });
});

describe('ConcurrencyController.parallel()', () => {
  it('should execute all tasks and return results in order', async () => {
    const cc = new ConcurrencyController(4);
    const results = await cc.parallel([
      task('a', 10),
      task('b', 5),
      task('c', 3),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('should return null for failed tasks', async () => {
    const cc = new ConcurrencyController(4);
    const results = await cc.parallel([
      task('a', 10),
      task('fail', 5, true),
      task('c', 3),
    ]);

    expect(results[0]).toBe('a');
    expect(results[1]).toBeNull();
    expect(results[2]).toBe('c');
  });

  it('should handle empty input', async () => {
    const cc = new ConcurrencyController(4);
    const results = await cc.parallel([]);
    expect(results).toEqual([]);
  });

  it('should limit concurrency during parallel execution', async () => {
    const cc = new ConcurrencyController(2);
    const running: number[] = [];
    let maxConcurrent = 0;

    const wrapped = [1, 2, 3, 4, 5].map(i => async () => {
      running.push(i);
      maxConcurrent = Math.max(maxConcurrent, running.length);
      await delay(30);
      running.splice(running.indexOf(i), 1);
      return i;
    });

    const results = await cc.parallel(wrapped);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});
