/**
 * Memory recall engine.
 *
 * Searches the memory directory for files relevant to the user's current query
 * using keyword-based Jaccard similarity scoring. Top N results are injected
 * as system-reminder context messages.
 *
 * Provider-agnostic: pure text processing, no LLM calls.
 *
 * Based on the claude-code-best findRelevantMemories pattern, adapted for
 * Coderix's architecture.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import { getMemoryDir, isAutoMemPath } from './memory-directory.js';
import { scanMemoryFiles, type MemoryFileHeader, parseMemoryFile } from './frontmatter.js';
import { rankMemories, type MemoryWithText } from './scorer.js';
import { memoryAge, memoryFreshnessText } from './staleness.js';
import type { MemoryConfig, MemoryEntry } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecalledMemory {
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
  name: string;
  description: string;
  age: string;
}

// ---------------------------------------------------------------------------
// Recall logic
// ---------------------------------------------------------------------------

interface RelevanceCandidate extends MemoryWithText {
  filePath: string;
  mtimeMs: number;
}

/**
 * Find memory files relevant to a user query.
 *
 * Algorithm:
 *   1. Scan memory directory for .md files (capped at maxMemoryFiles)
 *   2. Read frontmatter (name, description) from each file
 *   3. Score each memory against the query using Jaccard similarity
 *   4. Return top N results with full content and staleness warnings
 *
 * @param query - The user's current query text
 * @param cwd - Working directory for memory path resolution
 * @param config - Memory configuration
 * @param alreadySurfaced - Set of paths already shown in this session
 * @param signal - AbortSignal for cancellation
 * @returns Top relevant memories (empty array if none found or recall disabled)
 */
export async function findRelevantMemories(
  query: string,
  cwd: string,
  config: MemoryConfig,
  alreadySurfaced: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<RecalledMemory[]> {
  if (!config.enabled || !config.recallEnabled) return [];
  if (!query.trim()) return [];

  const memoryDir = getMemoryDir(cwd);
  const maxResults = config.recallMaxResults;

  // Step 1: Scan memory files (headers only — fast)
  const headers = await scanMemoryFiles(
    memoryDir,
    config.maxMemoryFiles,
    signal,
  );

  if (signal?.aborted) return [];

  // Filter out already-surfaced memories
  const candidates: RelevanceCandidate[] = [];
  for (const h of headers) {
    if (alreadySurfaced.has(h.filePath)) continue;
    // Skip files without a useful description (can't match)
    if (!h.description) continue;

    candidates.push({
      name: h.filename.replace(/\.md$/, ''),
      description: h.description,
      filePath: h.filePath,
      mtimeMs: h.mtimeMs,
    });
  }

  if (candidates.length === 0) return [];

  // Step 2: Rank by relevance
  const ranked = rankMemories(query, candidates, 0.05);

  // Step 3: Take top N
  const topN = ranked.slice(0, maxResults);
  if (topN.length === 0) return [];

  // Step 4: Read full content for top matches
  const results: RecalledMemory[] = [];
  for (const { memory, score } of topN) {
    if (results.length >= maxResults) break;
    if (signal?.aborted) break;

    try {
      const parsed = await parseMemoryFile(memory.filePath);
      if (!parsed) continue;

      const age = memoryAge(memory.mtimeMs);
      const freshnessNote = memoryFreshnessText(
        memory.mtimeMs,
        config.stalenessThresholdDays,
      );

      let content = parsed.body.slice(0, 4000); // Cap content size
      if (freshnessNote) {
        content = `${freshnessNote}\n\n${content}`;
      }

      results.push({
        path: memory.filePath,
        content,
        mtimeMs: memory.mtimeMs,
        header: `**Recalled memory:** ${parsed.frontmatter.name} (${age})${
          score >= 0.3 ? '' : ' — low confidence match'
        }`,
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        age,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Relevance cache (session-scoped deduplication)
// ---------------------------------------------------------------------------

export class RelevanceCache {
  private surfacedPaths = new Set<string>();
  private sessionPathCache: string | null = null;

  /**
   * Mark paths as surfaced (shown to the model in this session).
   */
  markSurfaced(paths: string[]): void {
    for (const p of paths) {
      this.surfacedPaths.add(p);
    }
  }

  /**
   * Get the set of already-surfaced paths.
   */
  getSurfaced(): ReadonlySet<string> {
    return this.surfacedPaths;
  }

  /**
   * Check if a path has already been surfaced.
   */
  hasSurfaced(path: string): boolean {
    return this.surfacedPaths.has(path);
  }

  /**
   * Clear all surfaced tracking (called on new session or compact).
   */
  clear(): void {
    this.surfacedPaths.clear();
  }

  /**
   * Get the count of surfaced paths.
   */
  get surfedCount(): number {
    return this.surfacedPaths.size;
  }
}

// ---------------------------------------------------------------------------
// Convenience formatter
// ---------------------------------------------------------------------------

/**
 * Format recalled memories as a system-reminder context block.
 */
export function formatRecalledMemories(memories: RecalledMemory[]): string {
  if (memories.length === 0) return '';

  const blocks = memories.map((m, i) => {
    return [
      m.header,
      '',
      m.content.slice(0, 2000), // Truncate each memory to 2000 chars max
    ].join('\n');
  });

  return `<system-reminder>\nThe following memories were found relevant to the current query:\n\n${blocks.join('\n\n---\n\n')}\n</system-reminder>`;
}
