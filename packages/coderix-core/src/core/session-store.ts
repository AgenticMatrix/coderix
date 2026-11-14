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

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import type {
  Session,
  SessionEntry,
  TranscriptEntry,
  Message,
  TokenUsageSummary,
} from './types.js';
import { isTranscriptEntry } from './types.js';
import {
  fallbackSessionTitle,
  isPlaceholderTitle,
  normalizeSessionTitle,
  type SessionTitleSource,
} from './session-title.js';
import type { SessionClient } from './session-lease.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// CODERIX_SESSIONS_DIR is an escape hatch for tests (and for running isolated
// instances without touching the user's real transcripts).
export const SESSIONS_DIR = process.env.CODERIX_SESSIONS_DIR
  ? resolve(process.env.CODERIX_SESSIONS_DIR)
  : join(homedir(), '.coderix', 'sessions');

export function sessionDir(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId);
}

export function sessionJsonlPath(sessionDir: string): string {
  return join(sessionDir, 'session.jsonl');
}

export function sessionSystemPromptPath(sessionDir: string): string {
  return join(sessionDir, 'system_prompt.md');
}

export function sessionMetaPath(sessionDir: string): string {
  return join(sessionDir, 'meta.json');
}

export function legacySessionJsonPath(sessionDir: string): string {
  return join(sessionDir, 'session.json');
}

export function subAgentDir(sessionDir: string, agentId: string): string {
  return join(sessionDir, 'subagents', agentId);
}

export function subAgentJsonlPath(sessionDir: string, agentId: string): string {
  return join(subAgentDir(sessionDir, agentId), 'transcript.jsonl');
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
  const line = JSON.stringify(entry) + '\n';
  try {
    appendFileSync(filePath, line, { mode: 0o600 });
  } catch {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
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

/**
 * Read one page of transcript messages from the tail of a JSONL file,
 * newest-page-first.
 *
 * Pages are cut by `beforeUuid` (exclusive) so a caller can walk backwards
 * through the transcript without ever holding it whole: the first call passes
 * no cursor and gets the tail page, and each older page passes the oldest uuid
 * it has seen. Unlike a count-based cap this never *drops* history — it only
 * decides how much of it is loaded.
 *
 * The page boundary is aligned to a user turn where possible: a page that
 * would begin mid-turn extends back to the start of that turn, so a call is
 * never split between two pages (its tool calls and results stay together).
 * A single turn can still be enormous (one CAD render command with megabytes
 * of output), so `maxBytes` bounds the page independently of entry count —
 * that trim happens *inside* a turn and never between a tool call and its
 * result.
 *
 * Only the region just above the cursor is read, so cost tracks the page size
 * rather than how far the reader has scrolled. `beforeOffset` is that region's
 * anchor: it is the byte offset the previous page reported as `oldestOffset`,
 * letting a deep page start from there instead of re-reading from the file
 * tail (which would grow with every page the user loads).
 *
 * @param filePath - session JSONL path.
 * @param beforeUuid - exclusive cursor; omit to start at the newest message.
 * @param maxMessages - soft cap on transcript entries in this page.
 * @param maxBytes - soft cap on serialized message bytes in this page.
 * @param beforeOffset - byte offset of `beforeUuid`, from the previous page's
 *   `oldestOffset`; a seek hint that keeps deep pages cheap.
 * @returns the page's `Message`s in file order, the oldest uuid and byte offset
 *   for the next call, and whether anything older still remains.
 */
export function readMessagePageSync(
  filePath: string,
  beforeUuid: string | undefined,
  maxMessages: number,
  maxBytes = 2 * 1024 * 1024,
  beforeOffset?: number,
): {
  messages: Message[];
  uuids: string[];
  oldestUuid: string | null;
  oldestOffset: number | null;
  hasMore: boolean;
} {
  const empty = {
    messages: [] as Message[],
    uuids: [] as string[],
    oldestUuid: null,
    oldestOffset: null,
    hasMore: false,
  };
  if (!existsSync(filePath)) return empty;

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return empty;
  }
  if (size === 0) return empty;

  // A cursor offset is only safe while the file is append-only: trust it when
  // the line there still carries the expected uuid, else fall back to scanning
  // from the tail (a rewritten/compacted transcript invalidates old offsets).
  let anchor: number | undefined;
  if (beforeOffset !== undefined && beforeOffset > 0 && beforeOffset < size) {
    const atOffset = readEntryUuidAt(filePath, beforeOffset);
    if (beforeUuid === undefined || atOffset === beforeUuid) anchor = beforeOffset;
  }

  // Grow the window until the page is satisfied (or the file start).
  let windowBytes = Math.max(256 * 1024, maxMessages * 8 * 1024);
  for (;;) {
    const windowEnd = anchor ?? size;
    const start = Math.max(0, windowEnd - windowBytes);
    const buffer = Buffer.alloc(windowEnd - start);
    let fd: number | null = null;
    try {
      fd = openSync(filePath, 'r');
      readSync(fd, buffer, 0, buffer.length, start);
    } catch {
      return empty;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }

    // Parse on the byte buffer so each entry's absolute offset is exact — a
    // string round-trip would confuse bytes with UTF-16 units.
    let lineStart = 0;
    if (start > 0) {
      // Skip the first (possibly partial) line.
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        // Not even one complete line fits in the window — the tail line alone
        // is larger (a single tool result can be several MB). Widen; a
        // non-growing window would return an empty page and strand the user
        // with no history at all.
        if (start === 0) return empty;
        windowBytes *= 2;
        continue;
      }
      lineStart = newline + 1;
    }

    const entries: TranscriptEntry[] = [];
    const entryOffsets: number[] = [];
    for (let i = lineStart; i <= buffer.length; i++) {
      if (i !== buffer.length && buffer[i] !== 0x0a) continue;
      let from = lineStart;
      let to = i;
      // Leading/trailing ASCII whitespace only — JSON never needs more.
      while (from < to && (buffer[from] === 0x20 || buffer[from] === 0x09 || buffer[from] === 0x0d)) from++;
      while (to > from && (buffer[to - 1] === 0x20 || buffer[to - 1] === 0x09 || buffer[to - 1] === 0x0d)) to--;
      if (to > from) {
        try {
          const entry = JSON.parse(buffer.toString('utf-8', from, to)) as SessionEntry;
          if (isTranscriptEntry(entry)) {
            entries.push(entry);
            entryOffsets.push(start + from);
          }
        } catch {
          /* partial or corrupted line — skipped; broadening the window covers it */
        }
      }
      lineStart = i + 1;
    }
    // A window that starts inside one oversized line yields only that line's
    // tail (or nothing at all). Widen until a whole entry is readable rather
    // than reporting "no more history" over a transcript that has plenty.
    if (entries.length === 0 && start > 0) {
      windowBytes *= 2;
      continue;
    }

    // Apply the cursor (exclusive). With a byte anchor the page is everything
    // before it; otherwise find the cursor's entry in the window.
    let end = entries.length;
    if (anchor === undefined && beforeUuid !== undefined) {
      const idx = entries.findIndex((e) => e.uuid === beforeUuid);
      if (idx < 0) {
        // The cursor is older than this window: widen until it is visible so
        // the page is never cut at the wrong place.
        if (start === 0) return empty;
        windowBytes *= 2;
        continue;
      }
      // A cursor at the very start of the window has nothing readable before
      // it *in this window*; widen rather than returning an empty page.
      if (idx === 0 && start > 0) {
        windowBytes *= 2;
        continue;
      }
      end = idx;
    }
    if (end === 0) return empty;

    // Walk backwards to the page cut, then extend to a user-turn boundary.
    let cut = end;
    let counted = 0;
    let bytes = 0;
    let hitByteBudget = false;
    for (let i = end - 1; i >= 0; i--) {
      const entry = entries[i]!;
      // Measure the serialized message, not the raw line, so the budget
      // reflects what actually crosses IPC.
      bytes += JSON.stringify(entry.message).length;
      counted++;
      cut = i;
      if (counted >= maxMessages) break;
      // A tool_result must never be separated from the call it answers, so the
      // byte budget stops the page only at messages that begin a unit.
      if (bytes >= maxBytes && i > 0 && !isToolResultCarrier(entry)) {
        hitByteBudget = true;
        break;
      }
    }

    // Paging normally begins on a real user prompt. A single turn can be far
    // larger than the byte budget though (one tool call with a multi-MB
    // result), and pulling the whole turn in would defeat the purpose — so the
    // alignment yields to the budget in that case. The cut still never splits
    // a tool_result from its call, which is what keeps the turn renderable.
    if (!hitByteBudget) {
      while (cut > 0 && !startsUserTurn(entries[cut]!)) cut--;
      // The window may not contain the turn's opening message; widen for it.
      if (cut === 0 && start > 0 && !startsUserTurn(entries[0]!)) {
        windowBytes *= 2;
        continue;
      }
    } else {
      // Never start a page on a bare tool result.
      while (cut > 0 && isToolResultCarrier(entries[cut]!)) cut--;
    }

    // Turn-boundary alignment can still land between a tool_use and the
    // tool_result answering it, when a synthetic user message (a background-task
    // notification, say) sits between the two. Rendering page by page would then
    // show a result with no card. Pull the cut back over every call the page's
    // results depend on; widen the window if such a call is older still.
    const alignedCut = pullCutBeforeToolCalls(entries, cut, end, start > 0);
    if (alignedCut === null) {
      windowBytes *= 2;
      continue;
    }
    cut = alignedCut;

    const page = entries.slice(cut, end);
    const pageOffsets = entryOffsets.slice(cut, end);
    // `cut`/`end` are file positions: they decide what belongs to this page and
    // anchor the next cursor (a byte offset). The *display order* inside the
    // page must instead follow parentUuid, matching a whole-file read — see
    // orderPageByChain.
    const displayOrder = orderPageByChain(page);
    const hasMore = cut > 0 || start > 0;
    return {
      messages: displayOrder.map((i) => page[i]!.message),
      // Parallel to `messages`; ids are transcript uuids so rows keep identity
      // across a reload or an older-page prepend.
      uuids: displayOrder.map((i) => page[i]!.uuid),
      // The cursor stays the file-oldest entry of the page, which is what the
      // next read must page before — display order is irrelevant to seeking.
      oldestUuid: page.length > 0 ? page[0]!.uuid : null,
      oldestOffset: pageOffsets.length > 0 ? pageOffsets[0]! : null,
      hasMore,
    };
  }
}

/**
 * Order one page by parentUuid chain, returning indices into `page`.
 *
 * A transcript line's position is when it was written, not when it happened:
 * concurrent writers can append lines out of order — a tool_result above the
 * tool_use that spawned it, or successive assistant messages swapped (57 of 316
 * local transcripts show this; 534 inversions, most one line apart). A
 * whole-file read resolves it by walking the parent link (see
 * `entriesToMessages`); a page has to resolve it the same way, or the reader
 * sees results that never attach to their card and turns in the wrong order.
 *
 * Only display order uses this. Page membership and the cursor stay on file
 * order: reordering *and* seeking by byte offset would re-read or skip the
 * neighbours that the reorder moved across the boundary.
 */
function orderPageByChain(page: TranscriptEntry[]): number[] {
  const n = page.length;
  if (n <= 1) return n > 0 ? [0] : [];

  const indexOfUuid = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOfUuid.set(page[i]!.uuid, i);

  const hasChild = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const parent = page[i]!.parentUuid;
    if (!parent) continue;
    const at = indexOfUuid.get(parent);
    if (at !== undefined) hasChild[at] = 1;
  }

  const chainFrom = (leafIdx: number): number[] => {
    const chain: number[] = [];
    const seen = new Set<number>();
    let current: number | undefined = leafIdx;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      const parent: string | null = page[current]!.parentUuid ?? null;
      current = parent ? indexOfUuid.get(parent) : undefined;
    }
    return chain.reverse();
  };

  // The longest chain inside the page is the trunk; shorter ones are concurrent
  // branches whose parent lies outside the page.
  let best: number[] = [];
  for (let i = 0; i < n; i++) {
    if (hasChild[i]) continue;
    const chain = chainFrom(i);
    if (chain.length > best.length) best = chain;
  }
  if (best.length === 0) best = chainFrom(n - 1);

  const emitted = new Uint8Array(n);
  const order: number[] = [];
  for (const idx of best) {
    if (emitted[idx]) continue;
    emitted[idx] = 1;
    order.push(idx);
  }

  // A concurrent writer's branch is not part of the trunk. `entriesToMessages`
  // appends it after the main line, ordered by timestamp within the branch;
  // doing the same here keeps a page's tail identical to a whole-file read
  // instead of interleaving two branches by raw write position.
  const branches: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (hasChild[i]) continue;
    const chain = chainFrom(i);
    if (best.includes(i)) continue;
    branches.push(chain);
  }
  const byTime = (a: number, b: number): number => {
    const dt = (page[a]!.timestamp ?? 0) - (page[b]!.timestamp ?? 0);
    return dt !== 0 ? dt : a - b;
  };
  branches.sort((a, b) => byTime(a[0] ?? 0, b[0] ?? 0));
  for (const branch of branches) {
    for (const idx of branch) {
      if (emitted[idx]) continue;
      emitted[idx] = 1;
      order.push(idx);
    }
  }

  // Anything still unreached (a cycle, or a parent outside the page) keeps its
  // file position — nothing is dropped, since dropping one would lose a message.
  for (let i = 0; i < n; i++) {
    if (emitted[i]) continue;
    emitted[i] = 1;
    order.push(i);
  }
  return order;
}

/**
 * The uuid of the transcript entry whose line starts at `offset`, or null when
 * no entry starts there (the file was rewritten, or the offset is stale).
 *
 * The offset is used as the *exclusive end* of the next page's read window, so
 * a value that is not exactly a line start would cut the final entry in half
 * and silently drop it. The byte before the offset must therefore be a newline.
 */
function readEntryUuidAt(filePath: string, offset: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const prev = Buffer.alloc(1);
    if (readSync(fd, prev, 0, 1, offset - 1) !== 1 || prev[0] !== 0x0a) return null;
    // The uuid field sits near the front of every transcript line, well inside
    // this window; the whole line is never needed to validate the offset.
    const buf = Buffer.alloc(1024);
    const read = readSync(fd, buf, 0, buf.length, offset);
    if (read <= 0) return null;
    const head = buf.toString('utf-8', 0, read);
    const match = /"uuid"\s*:\s*"([0-9a-fA-F-]{8,})"/.exec(head);
    return match ? match[1]! : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** A message that opens a conversation turn (not a tool-result carrier). */
function startsUserTurn(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false;
  const content = entry.message.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b.type !== 'tool_result');
}

/** A user message that exists only to carry tool results for a prior call. */
function isToolResultCarrier(entry: TranscriptEntry): boolean {
  if (entry.type !== 'user') return false;
  const content = entry.message.content;
  return Array.isArray(content) && content.every((b) => b.type === 'tool_result');
}

/**
 * Move a page cut back so the page owns every tool call its results answer.
 *
 * Turn alignment assumes a result directly follows its call, but a synthetic
 * user message can be appended in between (a background-task notification, for
 * instance). The page would then start on the result of a call that lives on
 * the previous page, and the renderer — which folds a result into the card that
 * produced it, one page at a time — would show a result with no card.
 *
 * @returns the adjusted cut, or null when a required call is older than the
 *   window (the caller widens and retries); a call that is absent from the
 *   whole file is a pre-existing orphan and cannot be recovered.
 */
function pullCutBeforeToolCalls(
  entries: TranscriptEntry[],
  cut: number,
  end: number,
  windowStartsMidFile: boolean,
): number | null {
  const callIndex = new Map<string, number>();
  for (let i = 0; i < end; i++) {
    const content = entries[i]!.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use' && typeof b.id === 'string' && !callIndex.has(b.id)) {
        callIndex.set(b.id, i);
      }
    }
  }

  let next = cut;
  let missing = false;
  for (let i = cut; i < end; i++) {
    const content = entries[i]!.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const at = callIndex.get(b.tool_use_id);
      if (at === undefined) {
        missing = true;
        continue;
      }
      if (at < next) next = at;
    }
  }
  if (missing && windowStartsMidFile) return null;
  return next;
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
      // Skip corrupted lines (partial writes on crash).
      // `console.error` rather than `process.stderr.write`: this runs while the
      // TUI owns the terminal, and ink replays patched console output above its
      // frame. A raw write would move the cursor without ink knowing, so its
      // next repaint rewinds to the wrong row and strands the old frame.
      console.error(`[session-store] Skipping corrupted JSONL line ${i + 1} in ${filePath}`);
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
// Cross-process write serialization
// ---------------------------------------------------------------------------

/**
 * Per-session-dir promise chain. Serializes writes inside one process so two
 * appends (or an append racing a rewrite) cannot land out of order; the file
 * lock below handles other processes.
 */
const sessionWriteQueues = new Map<string, Promise<unknown>>();

function enqueueSessionWrite<T>(
  sessionDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionWriteQueues.get(sessionDir) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  sessionWriteQueues.set(sessionDir, next);
  next
    .finally(() => {
      if (sessionWriteQueues.get(sessionDir) === next) {
        sessionWriteQueues.delete(sessionDir);
      }
    })
    .catch(() => {});
  return next;
}

/**
 * Run `fn` while holding the transcript write lock for a session.
 *
 * The lock is held only around the append/rewrite itself, so a long-running
 * agent turn never blocks another session. Nested acquisition on the same
 * session directory deadlocks — callers must take the lock once.
 */
export async function withSessionWriteLock<T>(
  sessionDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return enqueueSessionWrite(sessionDir, async () => {
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const lockTarget = join(sessionDir, '.transcript.lock');
    try {
      await writeFile(lockTarget, '', { flag: 'wx', mode: 0o600 });
    } catch {
      /* already created by an earlier writer */
    }

    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 50, minTimeout: 5, maxTimeout: 100 },
    });
    try {
      return await fn();
    } finally {
      await release().catch(() => {});
    }
  });
}

/**
 * Wait until every queued transcript write (in this process) has landed.
 * Queues are module-level, so this also drains writes issued by per-session
 * SessionManager instances that share the same session object.
 */
export async function flushSessionWrites(): Promise<void> {
  // New writes can be enqueued while we await; loop until the map settles.
  for (let pass = 0; pass < 10; pass++) {
    const pending = Array.from(sessionWriteQueues.values());
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
    if (sessionWriteQueues.size === 0) return;
  }
}

/**
 * Read the uuid of the last transcript entry in a JSONL file without loading
 * the whole thing. Tool results make individual lines large, so the window
 * grows until a complete transcript line is found.
 */
export function readLastTranscriptUuidSync(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return null;
  }
  if (size === 0) return null;

  let windowBytes = 256 * 1024;

  for (;;) {
    const start = Math.max(0, size - windowBytes);
    const buffer = Buffer.alloc(size - start);
    let fd: number | null = null;
    try {
      fd = openSync(filePath, 'r');
      readSync(fd, buffer, 0, buffer.length, start);
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }

    let text = buffer.toString('utf-8');
    if (start > 0) {
      // Drop the first (possibly partial) line.
      const newline = text.indexOf('\n');
      if (newline < 0) {
        if (start === 0) return null;
        windowBytes *= 2;
        continue;
      }
      text = text.slice(newline + 1);
    }

    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as SessionEntry;
        if (isTranscriptEntry(entry)) return entry.uuid;
      } catch {
        /* partial or corrupted line — keep scanning backwards */
      }
    }

    if (start === 0) return null;
    windowBytes *= 2;
  }
}

/**
 * Rewrite a transcript from a compacted/truncated message set while keeping
 * entries another process appended that this process has never seen.
 *
 * `knownUuids` is the set of transcript entries the caller's in-memory session
 * represents. Entries on disk outside that set were appended by someone else
 * (or after this process loaded) and are re-chained onto the new tail instead
 * of being dropped. Entries inside the set are dropped on purpose — that is
 * what rewind/compaction asked for.
 */
export async function rewriteTranscriptPreservingExternal(
  sessionDir: string,
  entries: SessionEntry[],
  knownUuids: ReadonlySet<string>,
): Promise<{ tailUuid: string | null; externalCount: number; externalUuids: string[] }> {
  return withSessionWriteLock(sessionDir, async () => {
    const filePath = sessionJsonlPath(sessionDir);
    const diskEntries = readEntriesSync(filePath);
    const external = diskEntries.filter(
      (e): e is TranscriptEntry => isTranscriptEntry(e) && !knownUuids.has(e.uuid),
    );

    let tailUuid: string | null = entries.length
      ? ((entries[entries.length - 1] as TranscriptEntry).uuid ?? null)
      : null;
    const merged = [...entries];
    for (const entry of external) {
      merged.push({ ...entry, parentUuid: tailUuid } as SessionEntry);
      tailUuid = entry.uuid;
    }

    // Nothing to write and nothing on disk: leave the file absent.
    if (merged.length > 0) {
      await rewriteEntries(filePath, merged);
    }
    return {
      tailUuid,
      externalCount: external.length,
      externalUuids: external.map((e) => e.uuid),
    };
  });
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
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < transcriptEntries.length; i++) {
    const e = transcriptEntries[i]!;
    byUuid.set(e.uuid, e);
    fileIndex.set(e.uuid, i);
  }

  // Build child set: all uuids that are referenced as parentUuid
  const hasChild = new Set<string>();
  for (const e of transcriptEntries) {
    if (e.parentUuid) hasChild.add(e.parentUuid);
  }

  const walk = (leaf: TranscriptEntry): TranscriptEntry[] => {
    const chain: TranscriptEntry[] = [];
    const seen = new Set<string>();
    let current: TranscriptEntry | undefined = leaf;
    while (current) {
      if (seen.has(current.uuid)) break; // cycle guard
      seen.add(current.uuid);
      chain.push(current);
      current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
    }
    return chain.reverse();
  };

  // Find all leaf entries (no child references them)
  const leaves = transcriptEntries.filter((e) => !hasChild.has(e.uuid));

  if (leaves.length <= 1) {
    const leaf = leaves[0] ?? transcriptEntries[transcriptEntries.length - 1]!;
    return walk(leaf).map((e) => e.message);
  }

  // Multiple leaves mean the transcript was written by more than one writer at
  // once. Older builds silently replayed only the last leaf, which made the
  // other branch's turn vanish. Pick the longest (tie: most recent) chain as
  // the main line and merge every unreachable entry back by timestamp so no
  // message is lost from the view.
  let primary = walk(leaves[0]!);
  for (const leaf of leaves.slice(1)) {
    const chain = walk(leaf);
    if (chain.length > primary.length) {
      primary = chain;
    } else if (
      chain.length === primary.length &&
      lastTimestamp(chain) > lastTimestamp(primary)
    ) {
      primary = chain;
    }
  }

  const primaryUuids = new Set(primary.map((e) => e.uuid));
  const orphans = transcriptEntries.filter((e) => !primaryUuids.has(e.uuid));
  if (orphans.length === 0) return primary.map((e) => e.message);

  // Keep the primary chain's order untouched: it contains complete
  // tool_use/tool_result pairs, and re-sorting the whole transcript by
  // timestamp can place a result before its call (older writers appended
  // lines out of order). Append each orphan subtree after the main line
  // instead, preserving parent → child order within the recovered branch.
  const orphanUuids = new Set(orphans.map((e) => e.uuid));
  const childrenOf = new Map<string, TranscriptEntry[]>();
  const roots: TranscriptEntry[] = [];
  for (const orphan of orphans) {
    if (orphan.parentUuid && orphanUuids.has(orphan.parentUuid)) {
      const siblings = childrenOf.get(orphan.parentUuid) ?? [];
      siblings.push(orphan);
      childrenOf.set(orphan.parentUuid, siblings);
    } else {
      roots.push(orphan);
    }
  }

  const byTime = (a: TranscriptEntry, b: TranscriptEntry): number => {
    const dt = (a.timestamp ?? 0) - (b.timestamp ?? 0);
    if (dt !== 0) return dt;
    return (fileIndex.get(a.uuid) ?? 0) - (fileIndex.get(b.uuid) ?? 0);
  };
  roots.sort(byTime);
  for (const siblings of childrenOf.values()) siblings.sort(byTime);

  const merged = [...primary];
  const emitted = new Set<string>(primaryUuids);
  const emit = (entry: TranscriptEntry): void => {
    if (emitted.has(entry.uuid)) return;
    emitted.add(entry.uuid);
    merged.push(entry);
    for (const child of childrenOf.get(entry.uuid) ?? []) emit(child);
  };
  for (const root of roots) emit(root);
  // Entries whose parent never existed (or cycles) are appended last.
  for (const orphan of orphans) emit(orphan);

  console.error(
    `[session-store] Recovered ${orphans.length} message(s) from ${leaves.length} concurrent transcript branches`,
  );
  return merged.map((e) => e.message);
}

function lastTimestamp(chain: TranscriptEntry[]): number {
  return chain.length > 0 ? (chain[chain.length - 1]!.timestamp ?? 0) : 0;
}

/**
 * Strip the Claude Code SDK's continuation/auto-compact wrapper from a user
 * message string. When a session is resumed, the SDK prepends a summary ending
 * with a "[Latest message]" line — we keep only that final line.
 */
export function stripCompactWrapper(content: string): string {
  const marker = '[Latest message]';
  const idx = content.lastIndexOf(marker);
  if (idx < 0) return content;
  const after = content.slice(idx + marker.length).trim();
  return after || content;
}

/**
 * True when a user message is the compactor's synthetic continuation message
 * ("This session is being continued from a previous conversation…"). These
 * carry no topic signal and must not be used to derive a session title or
 * preview — otherwise a compacted session's list entry shows the summary
 * instead of its real subject.
 */
export function isCompactSummaryText(text: string): boolean {
  return text.trimStart().startsWith('This session is being continued');
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return stripCompactWrapper(content);
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
  firstUserText: string | null;
  entryCount: number;
  hasParent: boolean;
  transcriptEntryCount: number;
  hasAssistantEntry: boolean;
} {
  const result = {
    lastTitle: null as string | null,
    lastUserPreview: null as string | null,
    firstUserText: null as string | null,
    entryCount: 0,
    hasParent: false,
    transcriptEntryCount: 0,
    hasAssistantEntry: false,
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
        if (entry.type === 'user' || entry.type === 'assistant') {
          result.transcriptEntryCount++;
        }
        if (entry.type === 'assistant') {
          result.hasAssistantEntry = true;
        }
        if (!foundTitle && entry.type === 'title') {
          result.lastTitle = entry.title;
          foundTitle = true;
        }
        // Check user entries from end too (fast path for recent sessions)
        if (!foundUser && entry.type === 'user' && entry.message) {
          const text = extractUserText(entry.message.content);
          if (text && !isCompactSummaryText(text)) {
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
            if (text && !isCompactSummaryText(text)) {
              result.lastUserPreview = text.length > 60 ? text.slice(0, 60) + '...' : text;
              break;
            }
          }
        } catch { /* skip corrupted */ }
      }
    }

    // Always scan from start for the first user message (for title generation)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message) {
          const text = extractUserText(entry.message.content);
          if (text && !isCompactSummaryText(text)) {
            result.firstUserText = text;
            break;
          }
        }
      } catch { /* skip corrupted */ }
    }
  } catch {
    // File missing or unreadable
  }

  return result;
}

// ---------------------------------------------------------------------------
// Session meta.json — lightweight session metadata
// ---------------------------------------------------------------------------

export interface SessionMeta {
  title?: string;
  /** Where {@link title} came from; absent on legacy rows. */
  titleSource?: SessionTitleSource;
  /** Client that created this session; absent on legacy rows. */
  origin?: SessionClient;
  /** "provider/model" route that produced a provider title, when known. */
  titleModel?: string;
  /** Last known context token count (input + cache_read) before the most recent LLM call.
   *  Persisted so session resume can pre-populate the context bar instead of showing 0. */
  contextLength?: number;
  /** Working directory when the session was created or last resumed. */
  workDir?: string;
  /** Model the session is bound to ("provider/model-name"), restored on resume. */
  model?: string;
  /** Skills selected for this session (Claude Code skill names). Empty array = no skills enabled. */
  skills?: string[];
  /** MCP server names enabled for this session. */
  mcpServers?: string[];
  /** Agent registry key this session is bound to. */
  agentType?: string;
  /** Plugin name this session was created from. */
  pluginId?: string;
  /** Cumulative token usage across all turns, persisted for resume. */
  tokenUsage?: TokenUsageSummary;
  /** Cumulative cost in the currency the price configuration used, persisted for resume. */
  totalCost?: number;
  /** Currency code of {@link totalCost} (e.g. "USD", "CNY"). */
  currency?: string;
  /** Real context footprint (most recent call's input + output + cache_read). */
  contextTokens?: number;
}

/**
 * Read session metadata from meta.json.
 * Returns null if the file doesn't exist or is corrupted.
 */
export function readSessionMeta(sessionDir: string): SessionMeta | null {
  const metaPath = sessionMetaPath(sessionDir);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf-8');
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * Serialize `meta.json` writes across processes, not just within one.
 *
 * A lock file is used instead of locking meta.json itself: readers parse
 * meta.json directly, so the lock target must never be a JSON document.
 * Stale locks are reclaimed after 10s (a write holds it for sub-milliseconds).
 */
async function withMetaWriteLock<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
  const lockTarget = join(sessionDir, '.meta.lock');
  try {
    await writeFile(lockTarget, '', { flag: 'wx', mode: 0o600 });
  } catch {
    /* already created by an earlier writer */
  }
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    // Writes hold the lock for sub-milliseconds, so a 5s-old lock means the
    // holder died (or is wedged). Retries outlast `stale` so a crashed writer's
    // lock is reclaimed rather than making the next write fail.
    stale: 5_000,
    update: 2_500,
    retries: { retries: 60, minTimeout: 5, maxTimeout: 100 },
  });
  try {
    return await fn();
  } finally {
    await release().catch(() => {});
  }
}

/**
 * Per-directory write queues — serialize `writeSessionMeta` calls targeting the
 * same session so their read-modify-write cycles can't interleave. Concurrent
 * fire-and-forget writes (setCwd + addMessage first-write + title + contextLength
 * + contextTokens + …) would otherwise each read a stale meta.json and clobber
 * one another, corrupting the file and dropping fields (e.g. the plugin identity).
 */
const metaWriteQueues = new Map<string, Promise<void>>();

/**
 * Write session metadata to meta.json, merging with existing data.
 * Creates the session directory if it doesn't exist.
 *
 * Writes to the same session directory are serialized (queued) so each caller
 * merges over the previous caller's result instead of racing on the file.
 */
export function writeSessionMeta(
  sessionDir: string,
  meta: SessionMeta,
): Promise<void> {
  return enqueueSessionMetaWrite(sessionDir, meta, true);
}

/**
 * Write meta.json only if the session directory still exists.
 *
 * Used by background title refinement: a summary that resolves after the user
 * deleted the session must not recreate the directory via `mkdir`.
 */
export function writeSessionMetaExisting(
  sessionDir: string,
  meta: SessionMeta,
): Promise<void> {
  return enqueueSessionMetaWrite(sessionDir, meta, false);
}

function enqueueSessionMetaWrite(
  sessionDir: string,
  meta: SessionMeta,
  createDir: boolean,
): Promise<void> {
  const prev = metaWriteQueues.get(sessionDir) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // keep the chain alive after a prior write failure
    .then(() => writeSessionMetaUnsafe(sessionDir, meta, createDir));
  metaWriteQueues.set(sessionDir, next);
  next
    .finally(() => {
      // Prune the queue entry once it settles and no newer write is queued.
      if (metaWriteQueues.get(sessionDir) === next) metaWriteQueues.delete(sessionDir);
    })
    .catch(() => {});
  return next;
}

/**
 * Wait until every queued meta.json write (in this process) has landed.
 * Queues are module-level, so this also drains writes issued by per-session
 * SessionManager instances that share the same session object.
 */
export async function flushSessionMetaWrites(): Promise<void> {
  // New writes can be enqueued while we await; loop until the map settles.
  for (let pass = 0; pass < 10; pass++) {
    const pending = Array.from(metaWriteQueues.values());
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
    if (metaWriteQueues.size === 0) return;
  }
}

async function writeSessionMetaUnsafe(
  sessionDir: string,
  meta: SessionMeta,
  createDir: boolean,
): Promise<void> {
  const metaPath = sessionMetaPath(sessionDir);

  if (createDir) {
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  } else if (!existsSync(sessionDir)) {
    return;
  }

  try {
    await withMetaWriteLock(sessionDir, async () => {
      const existed = existsSync(metaPath);
      // Merge with existing meta so partial writes (e.g. title-only)
      // don't clobber other fields like contextLength.
      const existing = readSessionMeta(sessionDir);

      // The file exists but isn't usable JSON (a writer that predates the atomic
      // write below, or a manually damaged file). Merging `{ ...null, ...patch }`
      // would rewrite the file as *only* this patch and permanently drop workDir,
      // title and usage — that is how conversations lost their workspace. Refuse
      // patch-only writes and let the next full session snapshot (which carries
      // workDir) rebuild the file.
      if (existed && existing === null) {
        if (!meta.workDir) {
          console.error(
            `[session-store] meta.json in ${sessionDir} is unreadable — skipping partial write ` +
              `(${Object.keys(meta).join(', ')}); a full session save will rebuild it`,
          );
          return;
        }
        // A full snapshot is about to replace the damaged bytes. Keep them: the
        // real workspace path is often still readable inside the corruption
        // (e.g. in the tail of a spliced document), and the snapshot carries the
        // fallback workspace rather than the one the conversation actually used.
        await rename(metaPath, `${metaPath}.corrupt`).catch(() => {});
      }

      const merged = { ...existing, ...meta };

      // Write-then-rename: a concurrent reader never observes a truncated file,
      // and an interleaved writer can only replace the whole document instead of
      // splicing its bytes into the middle of ours.
      const tmpPath = `${metaPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
        await rename(tmpPath, metaPath);
      } catch (err) {
        await unlink(tmpPath).catch(() => {});
        throw err;
      }
    });
  } catch (err) {
    // Best-effort write path: callers fire-and-forget. Log instead of dropping
    // silently — a lock held by a crashed process (reclaimed after `stale`) or a
    // full disk would otherwise swallow the update without a trace.
    console.error(
      `[session-store] failed to write meta.json in ${sessionDir} ` +
        `(${Object.keys(meta).join(', ')}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Title management
// ---------------------------------------------------------------------------

/**
 * Generate a session title from the first user message.
 * Returns the deterministic fallback: the leading words within the byte cap.
 * LLM refinement is scheduled separately and replaces this when it succeeds.
 */
export function generateSessionTitle(firstUserText: string): string {
  return fallbackSessionTitle(firstUserText);
}

/**
 * Check whether a session title is auto-generated and could benefit
 * from LLM-powered summarization. Source-aware for new rows; legacy rows
 * keep the old placeholder regex.
 */
export function isAutoTitle(title: string, source?: SessionTitleSource): boolean {
  return isPlaceholderTitle(title, source);
}

/**
 * Refine a session's title using an LLM summarizer.
 * Skips titles that are already provider-generated or user-owned. Writes the
 * result (and its source) to meta.json.
 * Returns the new title, or null if no refinement was needed.
 */
export async function refineSessionTitle(
  sessionId: string,
  summarize: (text: string) => Promise<string>,
): Promise<string | null> {
  const dir = sessionDir(sessionId);
  const jsonlPath = sessionJsonlPath(dir);
  const { firstUserText } = readTailMetadata(jsonlPath);
  if (!firstUserText) return null;

  const meta = readSessionMeta(dir);
  if (meta?.titleSource === 'provider' || meta?.titleSource === 'user' || meta?.titleSource === 'fork') return null;
  if (meta?.title && !isAutoTitle(meta.title, meta.titleSource)) return null;

  try {
    const title = await summarize(firstUserText);
    const cleaned = normalizeSessionTitle(title);
    if (!cleaned) return null;
    await writeSessionMeta(dir, { title: cleaned, titleSource: 'provider' });
    return cleaned;
  } catch {
    return null;
  }
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
    console.error(`[session-store] Failed to parse legacy session.json in ${dir}`);
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

  // Write JSONL
  await rewriteEntries(jsonlPath, entries);

  // Rename legacy file as backup
  try {
    await rename(legacyPath, legacyPath + '.bak');
  } catch {
    console.error(`[session-store] Failed to rename legacy session.json in ${dir}`);
  }

  console.error(
    `[session-store] Migrated legacy session: ${session.id} (${session.messages.length} messages)`,
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
