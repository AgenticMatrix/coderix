/**
 * MEMORY.md index file management.
 *
 * MEMORY.md is the entrypoint index — a markdown file where each line is
 * a one-line link to a memory topic file. It is NOT a memory itself.
 *
 * Format:
 *   - [Like concise style](like-concise-style.md) — User feedback about concise responses
 *   - [Project deadline](project-deadline.md) — Q3 deliverables due 2026-09-30
 *
 * Constraints:
 *   - ≤ 200 lines (MAX_ENTRYPOINT_LINES)
 *   - ≤ 25,000 bytes (MAX_ENTRYPOINT_BYTES)
 *   - No frontmatter — this is just an index
 *   - Each entry should be concise (~150 chars)
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { access } from 'fs/promises';

import { getMemoryDir, getMemoryIndexPath } from './memory-directory.js';
import {
  type MemoryIndexEntry,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexLoadResult {
  entries: MemoryIndexEntry[];
  lineCount: number;
  byteCount: number;
  wasTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const LINK_LINE_RE = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:—\s*(.+))?$/;

/**
 * Parse a MEMORY.md content string into index entries.
 * Lines not matching the markdown link format are silently skipped.
 */
export function parseIndexContent(raw: string): MemoryIndexEntry[] {
  const lines = raw.split('\n');
  const entries: MemoryIndexEntry[] = [];

  for (const line of lines) {
    const match = line.match(LINK_LINE_RE);
    if (!match) continue;

    const [, name, path, description] = match;

    entries.push({
      name: name.trim(),
      path: path.trim(),
      description: (description ?? '').trim(),
      type: '',
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load the MEMORY.md index for a project.
 * Returns empty entries array if the file doesn't exist.
 */
export async function loadIndex(
  cwd: string = process.cwd(),
): Promise<IndexLoadResult> {
  const indexPath = getMemoryIndexPath(cwd);
  let raw = '';

  try {
    await access(indexPath); // Check existence before read
    raw = await readFile(indexPath, 'utf-8');
  } catch {
    return { entries: [], lineCount: 0, byteCount: 0, wasTruncated: false };
  }

  const trimmed = raw.trim();
  const byteCount = trimmed.length;
  const contentLines = trimmed.split('\n');
  const lineCount = contentLines.length;

  if (lineCount <= MAX_ENTRYPOINT_LINES && byteCount <= MAX_ENTRYPOINT_BYTES) {
    return {
      entries: parseIndexContent(trimmed),
      lineCount,
      byteCount,
      wasTruncated: false,
    };
  }

  // Truncate overflowing content
  let truncated = contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n');

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  return {
    entries: parseIndexContent(truncated),
    lineCount,
    byteCount,
    wasTruncated: true,
  };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Format index entries back into MEMORY.md content.
 * Each entry: `- [name](path) — description`
 */
export function formatIndexContent(entries: MemoryIndexEntry[]): string {
  return entries
    .map(e => {
      const desc = e.description ? ` — ${e.description}` : '';
      return `- [${e.name}](${e.path})${desc}`;
    })
    .join('\n') + '\n';
}

/**
 * Save the full index to MEMORY.md. Overwrites the file.
 * Callers must ensure entries are unique (dedup before calling).
 */
export async function saveIndex(
  entries: MemoryIndexEntry[],
  cwd: string = process.cwd(),
): Promise<void> {
  const indexPath = getMemoryIndexPath(cwd);
  const content = formatIndexContent(entries);

  // Enforce size limits
  if (content.length > MAX_ENTRYPOINT_BYTES) {
    throw new Error(
      `Memory index exceeds ${MAX_ENTRYPOINT_BYTES} bytes. ` +
        `Remove some entries before saving.`,
    );
  }

  await writeFile(indexPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Entry management
// ---------------------------------------------------------------------------

/**
 * Add a single entry to MEMORY.md. Creates the file if it doesn't exist.
 *
 * If an entry with the same path already exists, it is updated.
 * Appends to the end of the file.
 */
export async function addIndexEntry(
  entry: MemoryIndexEntry,
  cwd: string = process.cwd(),
): Promise<void> {
  const { entries } = await loadIndex(cwd);

  // Remove existing entry with the same path (if any)
  const filtered = entries.filter(e => e.path !== entry.path);

  // Append new entry
  filtered.push(entry);

  await saveIndex(filtered, cwd);
}

/**
 * Remove an entry from MEMORY.md by file path.
 */
export async function removeIndexEntry(
  filePath: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const { entries } = await loadIndex(cwd);

  const filtered = entries.filter(e => e.path !== filePath);

  if (filtered.length === entries.length) {
    // No matching entry found
    return;
  }

  await saveIndex(filtered, cwd);
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * Format index entries as a condensed listing for system prompt injection.
 * Shows up to `maxEntries` most recent entries (by file mtime, via caller).
 *
 * Each line: `- [name](path) — description`
 */
export function condenseIndex(
  entries: MemoryIndexEntry[],
  maxEntries: number = 50,
): string {
  if (entries.length === 0) {
    return 'No memories saved yet.';
  }

  const shown = entries.slice(0, maxEntries);
  const lines = shown.map(
    e => `- [${e.name}](${e.path})${e.description ? ` — ${e.description}` : ''}`,
  );

  if (entries.length > maxEntries) {
    lines.push(
      '',
      `> Showing ${maxEntries} of ${entries.length} memories. Use Read to browse all files in the memory directory.`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Remove stale index entries (files that no longer exist).
 * Returns the number of entries removed.
 */
export async function cleanStaleEntries(
  cwd: string = process.cwd(),
): Promise<number> {
  const { entries } = await loadIndex(cwd);
  const memDir = getMemoryDir(cwd);

  const valid: MemoryIndexEntry[] = [];
  let removed = 0;

  for (const entry of entries) {
    try {
      const absPath = join(memDir, entry.path);
      await access(absPath);
      valid.push(entry);
    } catch {
      removed++;
    }
  }

  if (removed > 0) {
    await saveIndex(valid, cwd);
  }

  return removed;
}
