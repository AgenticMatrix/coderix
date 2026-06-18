/**
 * Tests for pipeline execution — true concurrency across stages.
 */

import { describe, expect, it } from 'vitest';
import { ConcurrencyController, executePipeline } from '../../src/workflow/concurrency.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executePipeline', () => {
  it('should run all items through all stages', async () => {
    const cc = new ConcurrencyController(4);

    const items = ['a', 'b', 'c'];
    const stage1 = async (item: string, _i: number) => `${item}-stage1`;
    const stage2 = async (item: string, _i: number) => `${item}-stage2`;

    const results = await executePipeline(items, [stage1, stage2], cc);
    expect(results).toEqual(['a-stage1-stage2', 'b-stage1-stage2', 'c-stage1-stage2']);
  });

  it('should pipeline — item B completes while item A is stuck in stage2', async () => {
    // With concurrency=2, both items run through all stages concurrently.
    // If item A blocks in stage2, item B should still complete (proving pipelining).
    const cc = new ConcurrencyController(2);

    let aBlockedInStage2 = false;
    let bCompleted = false;
    let bCompletedWhileABlocked = false;

    const items = ['a', 'b'];
    const stage1 = async (item: string, _i: number) => `${item}-s1`;

    const stage2 = async (item: string, i: number) => {
      if (i === 0) {
        // Item A (index 0)
        aBlockedInStage2 = true;
        // Block for a short time
        await new Promise(r => setTimeout(r, 30));
        aBlockedInStage2 = false;
      } else {
        // Item B (index 1): check if it's running while A is still in stage2
        if (aBlockedInStage2) {
          bCompletedWhileABlocked = true;
        }
        bCompleted = true;
      }
      return `${item}-s2`;
    };

    const results = await executePipeline(items, [stage1, stage2], cc);
    expect(results).toEqual(['a-s1-s2', 'b-s1-s2']);
    expect(bCompletedWhileABlocked).toBe(true);
  });

  it('should mark item as null when a stage throws', async () => {
    const cc = new ConcurrencyController(4);

    const items = ['a', 'bad', 'c'];
    const stage1 = async (item: string, _i: number) => {
      if (item === 'bad') throw new Error('bad item');
      return `${item}-s1`;
    };
    const stage2 = async (item: string, _i: number) => `${item}-s2`;

    const results = await executePipeline(items, [stage1, stage2], cc);

    expect(results[0]).toBe('a-s1-s2');
    expect(results[1]).toBeNull();
    expect(results[2]).toBe('c-s1-s2');
  });

  it('should skip remaining stages when an item fails', async () => {
    const cc = new ConcurrencyController(4);
    let stage2Calls = 0;

    const items = ['a', 'bad', 'c'];
    const stage1 = async (item: string, _i: number) => {
      if (item === 'bad') throw new Error('nope');
      return item;
    };
    const stage2 = async (item: string, _i: number) => {
      stage2Calls++;
      return `${item}-done`;
    };

    await executePipeline(items, [stage1, stage2], cc);
    // stage2 should only be called for 'a' and 'c' (not 'bad')
    expect(stage2Calls).toBe(2);
  });

  it('should handle single item', async () => {
    const cc = new ConcurrencyController(4);

    const stage1 = async (item: string, _i: number) => `${item}-ok`;
    const results = await executePipeline(['only'], [stage1], cc);
    expect(results).toEqual(['only-ok']);
  });

  it('should handle empty items', async () => {
    const cc = new ConcurrencyController(4);
    const results = await executePipeline([], [], cc);
    expect(results).toEqual([]);
  });

  it('should pass the item index to stages', async () => {
    const cc = new ConcurrencyController(4);
    const indices: number[] = [];

    const items = ['x', 'y', 'z'];
    const stage1 = async (item: string, i: number) => {
      indices.push(i);
      return item;
    };

    await executePipeline(items, [stage1], cc);
    expect(indices.sort()).toEqual([0, 1, 2]);
  });
});
