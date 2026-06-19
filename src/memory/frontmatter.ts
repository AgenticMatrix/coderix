/**
 * Frontmatter parsing for memory topic files.
 *
 * Uses gray-matter to parse YAML frontmatter from .md memory files.
 * Each memory file must have: name (slug), description (one-line summary),
 * and type (one of user/feedback/project/reference).
 *
 * Example:
 * ```markdown
 * ---
 * name: use-bun-not-npm
 * description: User prefers bun over npm for package management
 * type: user
 * ---
 *
 * Always use `bun add` instead of `npm install`.
 * ```
 */

import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import matter from 'gray-matter';

import {
  type MemoryFrontmatter,
  type MemoryType,
  parseMemoryType,
  MEMORY_TYPES,
} from './types.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate and coerce raw frontmatter data into a MemoryFrontmatter.
 * Returns null for invalid or missing required fields.
 */
export function validateMemoryFrontmatter(
  data: Record<string, unknown>,
): MemoryFrontmatter | null {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description =
    typeof data.description === 'string' ? data.description.trim() : '';

  const type = parseMemoryType(data.type);

  if (!name || !description || !type) {
    return null;
  }

  const fm: MemoryFrontmatter = { name, description, type };

  // Preserve optional metadata (supports nested values, not just strings)
  if (
    typeof data.metadata === 'object' &&
    data.metadata !== null &&
    !Array.isArray(data.metadata)
  ) {
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data.metadata)) {
      if (value !== undefined && value !== null) {
        meta[key] = value;
      }
    }
    if (Object.keys(meta).length > 0) {
      fm.metadata = meta;
    }
  }

  return fm;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedMemoryFile {
  /** The validated frontmatter. */
  frontmatter: MemoryFrontmatter;
  /** The body content (everything after the frontmatter). */
  body: string;
  /** Raw file path. */
  filePath: string;
}

/**
 * Parse a memory file from disk. Returns null if the file doesn't exist,
 * is unreadable, or has invalid frontmatter.
 */
export async function parseMemoryFile(
  filePath: string,
): Promise<ParsedMemoryFile | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');

    // Skip binary or empty files
    if (raw.length === 0) return null;

    // gray-matter parse
    const parsed = matter(raw);

    // Validate frontmatter
    const frontmatter = validateMemoryFrontmatter(parsed.data as Record<string, unknown>);
    if (!frontmatter) return null;

    return {
      frontmatter,
      body: parsed.content.trim(),
      filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Parse only the frontmatter (first ~30 lines) from a memory file.
 * Faster than parseMemoryFile for scanning/indexing — doesn't read the
 * full body. Returns null if the file doesn't exist or has invalid frontmatter.
 */
export async function parseMemoryHeader(
  filePath: string,
): Promise<MemoryFrontmatter | null> {
  try {
    // Read only the first 4KB — enough for any reasonable frontmatter block
    const raw = await readFileInRange(filePath, 0, 4096);
    if (!raw) return null;

    const parsed = matter(raw);
    return validateMemoryFrontmatter(parsed.data as Record<string, unknown>);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a range of bytes from a file. Used by parseMemoryHeader to avoid
 * reading large memory files just to check frontmatter.
 */
async function readFileInRange(
  filePath: string,
  start: number,
  length: number,
): Promise<string | null> {
  try {
    const { open } = await import('fs/promises');
    const fd = await open(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fd.read(buf, 0, length, start);
      return buf.toString('utf-8', 0, bytesRead);
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

export { readFileInRange };

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Create a new memory file with frontmatter and body content.
 * Overwrites existing files — callers should check existence first.
 */
export async function createMemoryFile(
  filePath: string,
  frontmatter: { name: string; description: string; type: MemoryType },
  body: string,
): Promise<void> {
  const lines: string[] = [
    '---',
    `name: ${frontmatter.name}`,
    `description: ${frontmatter.description}`,
    `type: ${frontmatter.type}`,
    '---',
    '',
    body,
  ];

  await writeFile(filePath, lines.join('\n') + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Bulk scanning (for recall / extraction)
// ---------------------------------------------------------------------------

export interface MemoryFileHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
}

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at maxFiles).
 *
 * Excludes MEMORY.md (the index file) from results.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  maxFiles: number = 200,
  signal?: AbortSignal,
): Promise<MemoryFileHeader[]> {
  try {
    const dirents = await readdir(memoryDir, { withFileTypes: true });
    const mdFiles = dirents.filter(
      d =>
        d.isFile() &&
        d.name.endsWith('.md') &&
        d.name !== 'MEMORY.md',
    );

    // Limit before doing I/O
    const candidates = mdFiles.slice(0, maxFiles);

    const results: MemoryFileHeader[] = [];

    for (const dirent of candidates) {
      if (signal?.aborted) break;

      const filePath = join(memoryDir, dirent.name);
      try {
        const stats = await stat(filePath);
        const frontmatter = await parseMemoryHeader(filePath);

        results.push({
          filename: dirent.name,
          filePath,
          mtimeMs: stats.mtimeMs,
          description: frontmatter?.description ?? null,
          type: frontmatter?.type,
        });
      } catch {
        // Skip unreadable files
      }
    }

    if (signal?.aborted) return [];

    // Sort newest first
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return results;
  } catch {
    return [];
  }
}

/**
 * Format memory file headers as a text manifest for prompts.
 * One line per file: `- [type] filename: description`
 */
export function formatMemoryManifest(headers: MemoryFileHeader[]): string {
  if (headers.length === 0) return '';

  return headers
    .map(h => {
      const tag = h.type ? `[${h.type}] ` : '';
      const ts = new Date(h.mtimeMs).toISOString();
      return h.description
        ? `- ${tag}${h.filename} (${ts}): ${h.description}`
        : `- ${tag}${h.filename} (${ts})`;
    })
    .join('\n');
}
