/**
 * ReadFileTracker — Lightweight tracker of recently read files.
 *
 * Used for post-compact file restoration: after LLM compaction prunes
 * old messages, recently read files are re-injected so the model doesn't
 * lose awareness of the codebase it was working with.
 */
export interface ReadFileEntry {
  path: string;
  content: string;
  timestamp: number;
}

export class ReadFileTracker {
  private entries: ReadFileEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 20) {
    this.maxEntries = maxEntries;
  }

  /** Record a file read. Content is capped per entry. */
  record(path: string, content: string): void {
    this.entries.push({
      path,
      content: content.length > 10_000 ? content.slice(0, 10_000) : content,
      timestamp: Date.now(),
    });
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /**
   * Get the most recently read files, deduplicated by path (last read wins).
   * Returns at most `maxFiles` entries, sorted most-recent first.
   */
  getRecent(maxFiles = 5): ReadFileEntry[] {
    const seen = new Set<string>();
    const result: ReadFileEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!;
      if (!seen.has(entry.path)) {
        seen.add(entry.path);
        result.push(entry);
        if (result.length >= maxFiles) break;
      }
    }
    return result;
  }

  /** Reset all tracked state. */
  clear(): void {
    this.entries = [];
  }
}
