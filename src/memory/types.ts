/**
 * Memory module shared types.
 *
 * Memories are constrained to four types capturing context NOT derivable
 * from the current project state. Code patterns, architecture, git history,
 * and file structure are derivable (via grep/git/CODERIX.md) and should NOT
 * be saved as memories.
 *
 * Based on the claude-code-best memory taxonomy.
 */

// ---------------------------------------------------------------------------
// Memory type taxonomy
// ---------------------------------------------------------------------------

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined;
  return MEMORY_TYPES.find(t => t === raw);
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
  metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Scanned memory header (frontmatter only, not full body)
// ---------------------------------------------------------------------------

export interface MemoryHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string | null;
  type: MemoryType | undefined;
}

// ---------------------------------------------------------------------------
// Full memory entry (for surfacing in context)
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  path: string;
  mtime: number;
  frontmatter: MemoryFrontmatter;
  body: string;
}

// ---------------------------------------------------------------------------
// MEMORY.md index entry
// ---------------------------------------------------------------------------

export interface MemoryIndexEntry {
  name: string;
  path: string;
  description: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MemorySettings {
  /** Enable the memory system (default: false). */
  enabled?: boolean;
  /** Enable auto-extraction after query turns (default: true). */
  autoExtract?: boolean;
  /** Extract every N turns (default: 10). */
  extractEveryNTurns?: number;
  /** Enable recall of relevant memories (default: true). */
  recallEnabled?: boolean;
  /** Max recalled memories to inject (default: 5). */
  recallMaxResults?: number;
  /** Days before staleness warnings appear (default: 1). */
  stalenessThresholdDays?: number;
}

export interface MemoryConfig {
  enabled: boolean;
  autoExtract: boolean;
  extractEveryNTurns: number;
  maxMemoryFiles: number;
  recallEnabled: boolean;
  recallMaxResults: number;
  stalenessThresholdDays: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  autoExtract: true,
  extractEveryNTurns: 10,
  maxMemoryFiles: 200,
  recallEnabled: true,
  recallMaxResults: 5,
  stalenessThresholdDays: 1,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ENTRYPOINT_NAME = 'MEMORY.md';
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
export const MAX_MEMORY_FILES = 200;
export const MAX_MEMORY_FILE_BYTES = 25_000;
