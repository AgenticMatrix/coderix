/**
 * tool-queue.ts — Streaming tool execution queue
 *
 * Tools are enqueued as soon as they are parsed from the LLM stream
 * (content_block_stop).  A bounded concurrency pool (default 32) limits
 * simultaneous executions.  Non-safe tools count toward the cap just like
 * any other tool — since they are rare, this is effectively a barrier.
 *
 * Progress events are buffered so callers can drain them between stream
 * event yields, giving the TUI live timers with minimal latency.
 */

import type { ToolUseBlock, ToolResultBlock, ToolProgress } from './types.js';

export class ToolExecutionQueue {
  private readonly maxConcurrency: number;
  private readonly signal: AbortSignal;
  private running = new Map<string, Promise<void>>();
  private pending: Array<{ block: ToolUseBlock; startFn: () => void }> = [];
  private results = new Map<string, ToolResultBlock>();
  private _progress: ToolProgress[] = [];
  private _allSettled: Promise<void> | null = null;
  private _resolveAll: (() => void) | null = null;

  constructor(maxConcurrency: number, signal: AbortSignal) {
    this.maxConcurrency = maxConcurrency;
    this.signal = signal;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Enqueue a tool for execution.  Starts immediately if under the cap. */
  enqueue(
    block: ToolUseBlock,
    execute: (block: ToolUseBlock) => Promise<ToolResultBlock>,
  ): void {
    const startFn = () => this._startSlot(block, execute);

    if (this.running.size < this.maxConcurrency) {
      startFn();
    } else {
      this.pending.push({ block, startFn });
    }
  }

  /** Store an error result for a tool that never ran (denied / aborted). */
  storeError(block: ToolUseBlock, message: string): void {
    this.results.set(block.id, {
      type: 'tool_result',
      tool_use_id: block.id,
      content: message,
      is_error: true,
    });
    this._progress.push({
      toolName: block.name,
      toolUseId: block.id,
      status: 'completed',
      is_error: true,
      message,
    });
  }

  /** Retrieve a completed result (or undefined if not yet finished). */
  getResult(toolUseId: string): ToolResultBlock | undefined {
    return this.results.get(toolUseId);
  }

  /** Drain and return all buffered progress events. */
  drainProgress(): ToolProgress[] {
    if (this._progress.length === 0) return [];
    const drained = this._progress;
    this._progress = [];
    return drained;
  }

  /** Wait until every running and pending tool has settled. */
  async waitForAll(): Promise<void> {
    if (this.running.size === 0 && this.pending.length === 0) return;
    if (!this._allSettled) {
      this._allSettled = new Promise<void>((resolve) => {
        this._resolveAll = resolve;
      });
    }
    return this._allSettled;
  }

  get runningCount(): number {
    return this.running.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private _startSlot(
    block: ToolUseBlock,
    execute: (block: ToolUseBlock) => Promise<ToolResultBlock>,
  ): void {
    // Emit running progress immediately so the TUI timer starts
    this._progress.push({
      toolName: block.name,
      toolUseId: block.id,
      status: 'running',
    });

    const promise = this._executeSlot(block, execute);
    this.running.set(block.id, promise);
  }

  private async _executeSlot(
    block: ToolUseBlock,
    execute: (block: ToolUseBlock) => Promise<ToolResultBlock>,
  ): Promise<void> {
    // Handle already-aborted before starting work
    if (this.signal.aborted) {
      this.storeError(block, 'Interrupted by user');
      this._settleSlot(block.id);
      return;
    }

    try {
      const result = await execute(block);
      this.results.set(block.id, result);
      this._progress.push({
        toolName: block.name,
        toolUseId: block.id,
        status: 'completed',
        is_error: result.is_error,
        message: result.is_error
          ? `Error: ${String(result.content)}`
          : String(result.content).slice(0, 500),
      });
    } catch (err: unknown) {
      this.results.set(block.id, {
        type: 'tool_result',
        tool_use_id: block.id,
        content: err instanceof Error ? err.message : String(err),
        is_error: true,
      });
      this._progress.push({
        toolName: block.name,
        toolUseId: block.id,
        status: 'completed',
        is_error: true,
        message: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this._settleSlot(block.id);
    }
  }

  private _settleSlot(toolUseId: string): void {
    this.running.delete(toolUseId);

    // Start the next pending tool (if any)
    if (this.pending.length > 0 && this.running.size < this.maxConcurrency) {
      const next = this.pending.shift()!;
      next.startFn();
    }

    // Signal all-settled if the queue is drained
    if (
      this.running.size === 0 &&
      this.pending.length === 0 &&
      this._resolveAll
    ) {
      this._resolveAll();
    }
  }
}
