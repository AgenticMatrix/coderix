/**
 * Checkpoint manager — enables workflow resume / replay.
 *
 * When a workflow script is executed, each agent() call is cached keyed by:
 *   script_hash + call_index + prompt_hash
 *
 * On re-execution with the same script and args, previously completed agent()
 * calls return their cached results instantly. The first call whose prompt
 * differs (or is missing) invalidates that call and all subsequent calls.
 *
 * Cache files are stored at ~/.coderix/workflow-cache/<sha256>.json
 * and are pruned after 7 days.
 */

import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import type { CheckpointData, CheckpointEntry } from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CACHE_DIR = join(homedir(), '.coderix', 'workflow-cache');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// CheckpointManager
// ---------------------------------------------------------------------------

export class CheckpointManager {
  private scriptHash: string;
  private data: CheckpointData;
  private dirty = false;
  private currentIndex = 0;
  /** After this index, all cached entries are invalid. */
  private invalidatedFrom: number | null = null;

  constructor(script: string, args?: Record<string, unknown>) {
    const payload = script + (args ? JSON.stringify(args) : '');
    this.scriptHash = hashString(payload);
    this.data = this._load();
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Try to get a cached result for the given prompt at the current call index.
   * Returns the cached result string, or `null` on cache miss.
   *
   * A cache hit requires:
   *   1. An entry exists at this index with the same prompt hash.
   *   2. No earlier call has invalidated the checkpoint sequence.
   *   3. The entry hasn't expired.
   */
  get(prompt: string): string | null {
    if (this.invalidatedFrom !== null && this.currentIndex >= this.invalidatedFrom) {
      return null;
    }

    const entry = this.data.entries.find(
      e => e.index === this.currentIndex && e.promptHash === hashString(prompt),
    );

    if (!entry) {
      // Only invalidate if we had previously cached entries at this index or beyond.
      // On a first run (empty cache), this is expected — don't set invalidatedFrom.
      const hasEntriesAtOrAfter = this.data.entries.some(
        e => e.index >= this.currentIndex,
      );
      if (hasEntriesAtOrAfter) {
        if (this.invalidatedFrom === null || this.currentIndex < this.invalidatedFrom) {
          this.invalidatedFrom = this.currentIndex;
          // Remove entries from this point onward
          this.data.entries = this.data.entries.filter(
            e => e.index < this.currentIndex,
          );
          this.dirty = true;
        }
      }
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.data.entries = this.data.entries.filter(
        e => e.index !== entry.index,
      );
      this.dirty = true;
      return null;
    }

    this.currentIndex++;
    return entry.result;
  }

  /**
   * Store a result for the current call index. Advances the index.
   */
  set(prompt: string, result: string): void {
    // Handle invalidation boundary:
    // - currentIndex < invalidatedFrom: we're before any issue → cache normally
    // - currentIndex == invalidatedFrom: we're filling the first changed call → allow, advance boundary
    // - currentIndex > invalidatedFrom: gap not filled → skip caching
    if (this.invalidatedFrom !== null) {
      if (this.currentIndex > this.invalidatedFrom) {
        this.currentIndex++;
        return;
      }
      // At the boundary: advance invalidatedFrom past this call
      this.invalidatedFrom = this.currentIndex + 1;
    }

    const entry: CheckpointEntry = {
      index: this.currentIndex,
      prompt,
      promptHash: hashString(prompt),
      result,
      timestamp: Date.now(),
    };

    // Replace existing entry at this index if present
    this.data.entries = this.data.entries.filter(
      e => e.index !== this.currentIndex,
    );
    this.data.entries.push(entry);
    this.dirty = true;
    this.currentIndex++;
  }

  /**
   * Persist any pending checkpoint data to disk.
   */
  save(): void {
    if (!this.dirty) return;

    ensureCacheDir();
    const filePath = join(CACHE_DIR, `${this.scriptHash}.json`);

    // Sort entries by index before saving
    this.data.entries.sort((a, b) => a.index - b.index);

    writeFileSync(filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    this.dirty = false;
  }

  /**
   * Get the current call index (for debugging / metrics).
   */
  get currentCallIndex(): number {
    return this.currentIndex;
  }

  /**
   * Total agent calls made across all executions (cached + new).
   */
  get totalCalls(): number {
    return Math.max(this.currentIndex, this.data.entries.length);
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private _load(): CheckpointData {
    ensureCacheDir();
    const filePath = join(CACHE_DIR, `${this.scriptHash}.json`);

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as CheckpointData;

      // Prune expired entries
      const cutoff = Date.now() - TTL_MS;
      const valid = data.entries.filter(e => e.timestamp >= cutoff);

      if (valid.length < data.entries.length) {
        this.dirty = true;
      }

      return {
        scriptHash: this.scriptHash,
        entries: valid,
      };
    } catch {
      return {
        scriptHash: this.scriptHash,
        entries: [],
      };
    }
  }
}
