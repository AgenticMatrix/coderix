/**
 * Global concurrency controller for workflow execution.
 *
 * Limits the number of concurrently executing agent() calls within a single
 * workflow. Tasks are queued when the limit is reached and dequeued as slots
 * free up.
 *
 * Concurrency limit: min(16, os.cpus().length - 2), minimum 1.
 */

import { cpus } from 'os';

// ---------------------------------------------------------------------------
// Concurrency limit
// ---------------------------------------------------------------------------

function computeMaxConcurrency(): number {
  const cores = cpus().length;
  const limit = Math.min(16, cores - 2);
  return Math.max(1, limit);
}

// ---------------------------------------------------------------------------
// ConcurrencyController
// ---------------------------------------------------------------------------

interface QueuedTask<T> {
  task: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  index: number;
}

export class ConcurrencyController {
  readonly maxConcurrent: number;
  private running = 0;
  private queue: Array<QueuedTask<unknown>> = [];
  private drained = false;

  constructor(maxConcurrent?: number) {
    this.maxConcurrent = maxConcurrent ?? computeMaxConcurrency();
  }

  /** Number of tasks currently executing. */
  get activeCount(): number {
    return this.running;
  }

  /** Number of tasks waiting in the queue. */
  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Enqueue a single task. If a slot is available immediately, executes it
   * right away; otherwise queues it and waits.
   *
   * This is the core primitive — parallel() routes all tasks through here.
   */
  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.drained) {
      throw new Error('ConcurrencyController has been drained — no new tasks accepted.');
    }

    // Fast path: slot available
    if (this.running < this.maxConcurrent) {
      this.running++;
      try {
        return await task();
      } finally {
        this.running--;
        this._dequeue();
      }
    }

    // Slow path: queue and wait
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
        index: this.queue.length,
      });
    });
  }

  /**
   * Execute multiple tasks concurrently with the concurrency limit enforced.
   * Returns results in the same order as the input thunks.
   *
   * A thunk that throws → the corresponding result is `null`. This applies
   * both to thunks that throw synchronously and those whose promise rejects.
   */
  async parallel<T>(
    thunks: Array<() => Promise<T>>,
  ): Promise<(T | null)[]> {
    const results: (T | null)[] = new Array(thunks.length).fill(null);
    const seenErrors: Error[] = [];

    // Wrap each thunk to catch errors and route through enqueue
    const wrapped = thunks.map((thunk, i) =>
      this.enqueue(async () => {
        try {
          results[i] = await thunk();
        } catch (err) {
          seenErrors.push(err instanceof Error ? err : new Error(String(err)));
          results[i] = null;
        }
        return results[i];
      }),
    );

    await Promise.all(wrapped);
    return results;
  }

  /**
   * Drain the queue — process one waiting task if any slots are free.
   */
  private _dequeue(): void {
    if (this.queue.length === 0) return;
    if (this.running >= this.maxConcurrent) return;

    const next = this.queue.shift()!;
    this.running++;

    next.task()
      .then(result => next.resolve(result))
      .catch(err => next.reject(err))
      .finally(() => {
        this.running--;
        this._dequeue();
      });
  }

  /**
   * Mark the controller as drained. No new tasks will be accepted.
   * Running tasks are not cancelled.
   */
  drain(): void {
    this.drained = true;
    // Reject any remaining queued tasks
    for (const item of this.queue) {
      item.reject(new Error('ConcurrencyController drained — task cancelled.'));
    }
    this.queue = [];
  }
}

/**
 * Execute items through a pipeline of stages with true concurrency.
 *
 * Unlike a simple sequential loop (for each item → for each stage), this
 * implementation allows Item B to enter Stage 1 while Item A is in Stage 2.
 *
 * Each item flows through all stages independently. If a stage throws, that
 * item is marked `null` and skipped for remaining stages.
 *
 * Internally, all item chains are run concurrently through the given
 * ConcurrencyController.
 */
export async function executePipeline<T>(
  items: T[],
  stages: Array<(item: T, index: number) => Promise<unknown>>,
  controller: ConcurrencyController,
): Promise<(unknown | null)[]> {
  const results: (unknown | null)[] = new Array(items.length).fill(null);

  // Each item runs through all stages independently
  const chains = items.map((item, i) =>
    controller.enqueue(async () => {
      let current: unknown = item;
      try {
        for (const stage of stages) {
          current = await stage(current as T, i);
        }
        results[i] = current;
      } catch {
        results[i] = null;
      }
      return results[i];
    }),
  );

  await Promise.all(chains);
  return results;
}
