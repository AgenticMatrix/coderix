/**
 * session-store.ts — JSONL-based append-only session persistence.
 *
 * Replaces the monolithic session.json with append-only JSONL files.
 * Each line is a SessionEntry JSON object. Transcript entries form a
 * parentUuid chain for conversation reconstruction.
 *
 * Directory layout:
 *   ~/.coderix/sessions/<uuid>/
 *     session.jsonl            # Main transcript (append-only)
 *     session.json.bak         # Legacy backup after migration
 *     subagents/
 *       agent-<id>.jsonl       # Per-sub-agent sidechain transcript
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  Session,
  SessionEntry,
  TranscriptEntry,
  Message,
} from './types.js';
import { isTranscriptEntry } from './types.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const SESSIONS_DIR = join(homedir(), '.coderix', 'sessions');

export function sessionDir(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId);
}

export function sessionJsonlPath(sessionDir: string): string {
  return join(sessionDir, 'session.jsonl');
}

export function legacySessionJsonPath(sessionDir: string): string {
  return join(sessionDir, 'session.json');
}

export function subAgentDir(sessionDir: string): string {
  return join(sessionDir, 'subagents');
}

export function subAgentJsonlPath(sessionDir: string, agentId: string): string {
  return join(subAgentDir(sessionDir), `agent-${agentId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Low-level JSONL I/O
// ---------------------------------------------------------------------------

/**
 * Append a single entry as a JSON line to a JSONL file.
 * Creates parent directories if they don't exist.
 * Uses fs.promises.appendFile for crash-safe appending.
 */
export async function appendEntry(
  filePath: string,
  entry: SessionEntry,
): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  try {
    await appendFile(filePath, line, { mode: 0o600 });
  } catch {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await appendFile(filePath, line, { mode: 0o600 });
  }
}

/**
 * Synchronous version of appendEntry for use in sync contexts.
 */
export function appendEntrySync(filePath: string, entry: SessionEntry): void {
  const { appendFileSync, mkdirSync: mkdirSync2 } = require('node:fs');
  const line = JSON.stringify(entry) + '\n';
  try {
    appendFileSync(filePath, line, { mode: 0o600 });
  } catch {
    mkdirSync2(dirname(filePath), { recursive: true, mode: 0o700 });
    appendFileSync(filePath, line, { mode: 0o600 });
  }
}

/**
 * Read all entries from a JSONL file.
 * Corrupted lines (invalid JSON) are skipped with a warning.
 * Returns entries in file order.
 */
export async function readEntries(filePath: string): Promise<SessionEntry[]> {
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseJsonlLines(raw, filePath);
}

/**
 * Synchronous version of readEntries.
 */
export function readEntriesSync(filePath: string): SessionEntry[] {
  if (!existsSync(filePath)) return [];

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseJsonlLines(raw, filePath);
}

function parseJsonlLines(raw: string, filePath: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip corrupted lines (partial writes on crash)
      process.stderr.write(
        `[session-store] Skipping corrupted JSONL line ${i + 1} in ${filePath}\n`,
      );
    }
  }
  return entries;
}

/**
 * Rewrite a JSONL file entirely with new entries.
 * Uses temp file + atomic rename for safety.
 */
export async function rewriteEntries(
  filePath: string,
  entries: SessionEntry[],
): Promise<void> {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });

  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, lines, { mode: 0o600 });

  try {
    await rename(tmpPath, filePath);
  } catch (err: unknown) {
    // On macOS APFS, rename can fail with ENOENT if the tmp file
    // is cleaned up between writeFile and rename. Fall back to
    // writing directly — we already have the data in memory.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await writeFile(filePath, lines, { mode: 0o600 });
      try { await unlink(tmpPath); } catch { /* best-effort cleanup */ }
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Transcript reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct a Message array from session entries in parentUuid chain order.
 *
 * Algorithm:
 * 1. Build a uuid→entry map for transcript entries
 * 2. Find the leaf (entry whose uuid is not referenced as anyone's parentUuid)
 * 3. Walk backwards from leaf to root following parentUuid
 * 4. Reverse to get root→leaf order
 * 5. Extract Message from each entry
 */
export function entriesToMessages(entries: SessionEntry[]): Message[] {
  const transcriptEntries = entries.filter(isTranscriptEntry);

  if (transcriptEntries.length === 0) return [];

  // Build uuid → entry map
  const byUuid = new Map<string, TranscriptEntry>();
  for (const e of transcriptEntries) {
    byUuid.set(e.uuid, e);
  }

  // Build child set: all uuids that are referenced as parentUuid
  const hasChild = new Set<string>();
  for (const e of transcriptEntries) {
    if (e.parentUuid) hasChild.add(e.parentUuid);
  }

  // Find all leaf entries (no child references them)
  const leaves = transcriptEntries.filter((e) => !hasChild.has(e.uuid));

  // Use the chronologically last leaf (highest index in the file = most recent)
  const leaf = leaves.length > 0 ? leaves[leaves.length - 1]! : transcriptEntries[transcriptEntries.length - 1]!;

  // Walk backwards from leaf following parentUuid
  const chain: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: TranscriptEntry | undefined = leaf;
  while (current) {
    if (seen.has(current.uuid)) break; // cycle guard
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }

  // Reverse to get chronological order
  chain.reverse();

  // Extract messages
  return chain.map((e) => e.message);
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(' ');
  }
  return '';
}

/**
 * Read the last ~64KB of a JSONL file to extract metadata (title, etc.).
 * Used for fast session listing without parsing the entire file.
 */
export function readTailMetadata(filePath: string): {
  lastTitle: string | null;
  lastUserPreview: string | null;
  entryCount: number;
  hasParent: boolean;
  transcriptEntryCount: number;
} {
  const result = {
    lastTitle: null as string | null,
    lastUserPreview: null as string | null,
    entryCount: 0,
    hasParent: false,
    transcriptEntryCount: 0,
  };

  if (!existsSync(filePath)) return result;

  try {
    const buf = readFileSync(filePath, { encoding: 'utf-8' });
    const lines = buf.split('\n').filter((l) => l.trim());
    result.entryCount = lines.length;

    // Scan for title entry from end (last-wins), and first user entry from start
    let foundTitle = false;
    let foundUser = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (foundTitle && foundUser && result.hasParent) break;
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (!result.hasParent && entry.type === 'parent-session') {
          result.hasParent = true;
        }
        if (!result.hasParent && entry.type === 'agent-metadata' && entry.agentId?.startsWith('sub-')) {
          result.hasParent = true;
        }
        if (entry.type === 'user' || entry.type === 'assistant') {
          result.transcriptEntryCount++;
        }
        if (!foundTitle && entry.type === 'title') {
          result.lastTitle = entry.title;
          foundTitle = true;
        }
        // Check user entries from end too (fast path for recent sessions)
        if (!foundUser && entry.type === 'user' && entry.message) {
          const text = extractUserText(entry.message.content);
          if (text) {
            result.lastUserPreview = text.length > 60 ? text.slice(0, 60) + '...' : text;
            foundUser = true;
          }
        }
      } catch { /* skip corrupted */ }
    }

    // Fallback: scan from start for first user message if not found from end
    if (!foundUser) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.message) {
            const text = extractUserText(entry.message.content);
            if (text) {
              result.lastUserPreview = text.length > 60 ? text.slice(0, 60) + '...' : text;
              break;
            }
          }
        } catch { /* skip corrupted */ }
      }
    }
  } catch {
    // File missing or unreadable
  }

  return result;
}

// ---------------------------------------------------------------------------
// Entry batcher — amortizes fsync cost
// ---------------------------------------------------------------------------

export interface EntryBatcher {
  append(entry: SessionEntry): void;
  flush(): Promise<void>;
  destroy(): void;
}

/**
 * Create a batcher that buffers entries and flushes them periodically.
 * Reduces fsync overhead for high-frequency addMessage() calls.
 */
export function createEntryBatcher(
  filePath: string,
  flushIntervalMs = 100,
): EntryBatcher {
  let buffer: SessionEntry[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let flushing = false;

  const doFlush = async (): Promise<void> => {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      const lines = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
      try {
        await appendFile(filePath, lines, { mode: 0o600 });
      } catch {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        await appendFile(filePath, lines, { mode: 0o600 });
      }
    } catch {
      // Re-insert on failure
      buffer = [...batch, ...buffer];
    } finally {
      flushing = false;
    }
  };

  timer = setInterval(() => {
    doFlush().catch(() => {});
  }, flushIntervalMs);

  // Don't prevent process exit
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    append(entry: SessionEntry): void {
      buffer.push(entry);
    },
    async flush(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      await doFlush();
    },
    destroy(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      buffer = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Migration from legacy session.json
// ---------------------------------------------------------------------------

/**
 * Migrate a legacy session.json to the new JSONL format.
 *
 * 1. Reads session.json
 * 2. Converts messages to JSONL entries with parentUuid chain
 * 3. Writes session.jsonl
 * 4. Renames session.json → session.json.bak
 *
 * Returns true if migration succeeded, false if no legacy file existed.
 */
export async function migrateLegacySession(dir: string): Promise<boolean> {
  const legacyPath = legacySessionJsonPath(dir);
  const jsonlPath = sessionJsonlPath(dir);

  if (!existsSync(legacyPath)) return false;

  let session: Session;
  try {
    const raw = readFileSync(legacyPath, 'utf-8');
    session = JSON.parse(raw) as Session;
  } catch {
    process.stderr.write(
      `[session-store] Failed to parse legacy session.json in ${dir}\n`,
    );
    return false;
  }

  // Convert messages to JSONL entries
  const entries: SessionEntry[] = [];
  let prevUuid: string | null = null;

  for (const msg of session.messages) {
    const uuid = randomUUID();
    const entry = {
      type: msg.role as 'user' | 'assistant' | 'system',
      uuid,
      parentUuid: prevUuid,
      timestamp: Date.now(),
      message: msg,
    };
    entries.push(entry as SessionEntry);
    prevUuid = uuid;
  }

  // Append title entry
  entries.push({
    type: 'title',
    title: session.title,
  } as SessionEntry);

  // Append agent-metadata entries for sub-agents
  if (session.metadata.subAgentIds) {
    for (const agentId of session.metadata.subAgentIds) {
      // Try to load agent metadata from legacy path
      const legacyAgentDir = join(homedir(), '.coderix', 'agents', agentId);
      const legacyMetaPath = join(legacyAgentDir, 'metadata.json');
      const legacyTranscriptPath = join(legacyAgentDir, 'transcript.json');

      let agentType = 'unknown';
      let prompt = '';
      let description: string | undefined;

      if (existsSync(legacyMetaPath)) {
        try {
          const meta = JSON.parse(readFileSync(legacyMetaPath, 'utf-8'));
          agentType = meta.agentType ?? 'unknown';
          prompt = meta.description ?? '';
          description = meta.displayDescription;
        } catch { /* skip */ }
      }

      entries.push({
        type: 'agent-metadata',
        agentId,
        agentType,
        prompt,
        description,
        timestamp: Date.now(),
      } as SessionEntry);

      // Migrate sub-agent transcript to JSONL
      if (existsSync(legacyTranscriptPath)) {
        try {
          const transcript: Message[] = JSON.parse(
            readFileSync(legacyTranscriptPath, 'utf-8'),
          );
          const agentEntries: SessionEntry[] = [];
          let agentPrevUuid: string | null = null;

          for (const msg of transcript) {
            const auuid = randomUUID();
            agentEntries.push({
              type: msg.role as 'user' | 'assistant' | 'system',
              uuid: auuid,
              parentUuid: agentPrevUuid,
              timestamp: Date.now(),
              message: msg,
            } as SessionEntry);
            agentPrevUuid = auuid;
          }

          const agentJsonlPath = subAgentJsonlPath(dir, agentId);
          await rewriteEntries(agentJsonlPath, agentEntries);
        } catch {
          process.stderr.write(
            `[session-store] Failed to migrate sub-agent transcript for ${agentId}\n`,
          );
        }
      }
    }
  }

  // Write JSONL
  await rewriteEntries(jsonlPath, entries);

  // Rename legacy file as backup
  try {
    await rename(legacyPath, legacyPath + '.bak');
  } catch {
    process.stderr.write(
      `[session-store] Failed to rename legacy session.json in ${dir}\n`,
    );
  }

  process.stderr.write(
    `[session-store] Migrated legacy session: ${session.id} (${session.messages.length} messages)\n`,
  );
  return true;
}

/**
 * Check if a session directory has legacy format (session.json exists
 * but session.jsonl does not). Returns true if migration is needed.
 */
export function needsMigration(dir: string): boolean {
  return existsSync(legacySessionJsonPath(dir)) && !existsSync(sessionJsonlPath(dir));
}
