/**
 * SessionManager — Session lifecycle management with JSONL persistence.
 *
 * Manages session creation, resume, fork, rewind, and persistence.
 * Sessions are stored as JSONL files in ~/.coderix/sessions/<uuid>/.
 *
 * Storage layout (v2):
 *   ~/.coderix/sessions/<uuid>/
 *     session.jsonl            # Append-only transcript entries
 *     session.json.bak         # Legacy backup (after migration)
 *     subagents/
 *       agent-<id>.jsonl       # Per-sub-agent sidechain transcript
 */

import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { IS_WINDOWS } from '../utils/platform.js';
import type {
  Session,
  SessionFilter,
  SessionSummary,
  TokenUsageSummary,
  Message,
  SessionEntry,
} from './types.js';
import { isTranscriptEntry } from './types.js';
import { tokenCountWithEstimation } from './token-budget.js';
import {
  SESSIONS_DIR,
  sessionDir as getSessionDir,
  sessionJsonlPath,
  appendEntry,
  appendEntrySync,
  readEntriesSync,
  rewriteEntries,
  entriesToMessages,
  readTailMetadata,
} from './session-store.js';

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private activeSession: Session | null = null;
  private sessions: Map<string, Session> = new Map();
  private pendingWrites = new Set<Promise<void>>();
  private exitHandlerRegistered = false;

  constructor() {
    if (!existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  /**
   * Create a new session.
   */
  create(options: {
    title?: string;
    cwd?: string;
    model?: string;
    provider?: string;
    parentSessionId?: string;
    baseCommit?: string;
  }): Session {
    const id = randomUUID();
    const now = new Date();
    const title = options.title ?? `Session ${id.slice(0, 8)}`;
    const session: Session = {
      id,
      title,
      status: 'active',
      messages: [],
      turnCount: 0,
      totalCost: 0,
      createdAt: now,
      updatedAt: now,
      cwd: options.cwd ?? process.cwd(),
      model: options.model ?? 'deepseek-v4-pro',
      provider: options.provider ?? 'anthropic',
      parentSessionId: options.parentSessionId,
      baseCommit: options.baseCommit,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 0,
      },
      metadata: {
        filesModified: [],
        toolsUsed: [],
        tags: [],
      },
    };

    this.sessions.set(id, session);
    this.activeSession = session;

    // Defer disk write until the first message is added.
    // This prevents empty sessions from leaving directories on disk.
    (session as any)._entryCount = 0;

    return session;
  }

  /**
   * Get the active session or throw.
   */
  getActive(): Session {
    if (!this.activeSession) {
      throw new Error('No active session. Call create() or resume() first.');
    }
    return this.activeSession;
  }

  /**
   * Get a session by ID.
   */
  get(id: string): Session | undefined {
    const cached = this.sessions.get(id);
    if (cached) return cached;

    return this.loadSession(id);
  }

  /**
   * Resume a session from disk.
   */
  resume(sessionId: string): Session {
    const session = this.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = 'active';
    session.updatedAt = new Date();

    this.sessions.set(sessionId, session);
    this.activeSession = session;

    // Re-append title to JSONL so it's in the tail for listing
    this.appendMetadata(session);

    return session;
  }

  /**
   * Fork a session — create a new session from the parent's messages up to a turn.
   */
  fork(options: { sessionId: string; fromTurn?: number; cwd?: string }): Session {
    const parent = this.get(options.sessionId);
    if (!parent) {
      throw new Error(`Parent session not found: ${options.sessionId}`);
    }

    const messages = options.fromTurn
      ? parent.messages.slice(0, options.fromTurn)
      : [...parent.messages];

    return this.create({
      title: `${parent.title} (fork)`,
      cwd: options.cwd ?? parent.cwd,
      model: parent.model,
      provider: parent.provider,
      parentSessionId: parent.id,
      baseCommit: parent.baseCommit,
    });
  }

  /**
   * Rewind a session to a specific turn.
   */
  rewind(sessionId: string, toTurn: number): Session {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    let turnCount = 0;
    const keptMessages: Message[] = [];

    for (const msg of session.messages) {
      keptMessages.push(msg);
      if (msg.role === 'assistant') {
        turnCount++;
      }
      if (turnCount >= toTurn) break;
    }

    session.messages = keptMessages;
    session.turnCount = toTurn;
    session.updatedAt = new Date();

    // Rebuild JSONL atomically
    this.rebuildJsonlFromSession(session);

    return session;
  }

  /**
   * Trim session messages to stay within a token budget.
   */
  trimMessages(maxTokens: number, minKeep = 10): number {
    const session = this.getActive();
    const totalTokens = tokenCountWithEstimation(session.messages);
    if (totalTokens <= maxTokens) return 0;

    const maxDrop = session.messages.length - minKeep;
    let keepStart = 0;
    for (let i = 0; i < maxDrop; i++) {
      keepStart = i + 1;
      const remaining = session.messages.slice(keepStart);
      if (tokenCountWithEstimation(remaining) <= maxTokens) break;
    }

    const dropped = keepStart;
    if (dropped === 0) return 0;

    session.messages = session.messages.slice(keepStart);
    session.updatedAt = new Date();
    this.saveSession(session);
    return dropped;
  }

  /**
   * Replace the active session's messages with a compacted set.
   */
  replaceMessages(messages: Message[]): void {
    const session = this.getActive();
    session.messages = [...messages];
    session.updatedAt = new Date();
    // Rebuild JSONL from compacted messages
    this.rebuildJsonlFromSession(session);
  }

  // Hard cap on in-memory messages to prevent unbounded heap growth.
  private static readonly MAX_MESSAGES = 600;

  /**
   * Add a message to the active session.
   * Appends to JSONL file AND updates in-memory messages array.
   */
  addMessage(message: Message): void {
    const session = this.getActive();

    // Track the last transcript entry's uuid for parentUuid chaining
    const prevUuid = (session as any)._lastEntryUuid as string | null ?? null;
    const uuid = randomUUID();

    const entry: SessionEntry = {
      type: message.role as 'user' | 'assistant' | 'system',
      uuid,
      parentUuid: prevUuid,
      timestamp: Date.now(),
      message,
    } as SessionEntry;

    (session as any)._lastEntryUuid = uuid;

    // Update in-memory state
    session.messages.push(message);
    session.updatedAt = new Date();

    if (message.role === 'assistant') {
      session.turnCount++;
    }

    // Enforce hard cap: drop oldest non-system messages when over limit
    if (session.messages.length > SessionManager.MAX_MESSAGES) {
      const excess = session.messages.length - SessionManager.MAX_MESSAGES;
      let dropped = 0;
      session.messages = session.messages.filter((m) => {
        if (dropped >= excess) return true;
        if (m.role !== 'system') {
          dropped++;
          return false;
        }
        return true;
      });
    }

    // Append to JSONL asynchronously (fire-and-forget with throttling)
    const dir = getSessionDir(session.id);
    const jsonlPath = sessionJsonlPath(dir);

    // Bootstrap the session.jsonl on first message: write title + parent metadata
    if (((session as any)._entryCount as number ?? 0) === 0) {
      const titleEntry: SessionEntry = {
        type: 'title',
        title: session.title,
      } as SessionEntry;
      appendEntry(jsonlPath, titleEntry).catch(() => {});
      (session as any)._entryCount = 1;

      if (session.parentSessionId) {
        const parentEntry: SessionEntry = {
          type: 'parent-session',
          parentSessionId: session.parentSessionId,
        } as SessionEntry;
        appendEntry(jsonlPath, parentEntry).catch(() => {});
        (session as any)._entryCount = 2;
      }
    }

    (session as any)._entryCount = ((session as any)._entryCount as number) + 1;

    // Throttle: small sessions flush every 5 messages,
    // large sessions (>200) every 20 messages
    const skip = session.messages.length > 200 ? 20 : 5;
    if (session.messages.length % skip === 0) {
      // Flush with pending write tracking
      const writePromise = appendEntry(jsonlPath, entry)
        .catch(() => {})
        .finally(() => {
          this.pendingWrites.delete(writePromise);
        });
      this.pendingWrites.add(writePromise);
    } else {
      // Fire-and-forget
      appendEntry(jsonlPath, entry).catch(() => {});
    }
  }

  /**
   * Update token usage for the active session.
   */
  updateUsage(usage: Partial<TokenUsageSummary>): void {
    const session = this.getActive();
    if (usage.inputTokens) session.tokenUsage.inputTokens += usage.inputTokens;
    if (usage.outputTokens) session.tokenUsage.outputTokens += usage.outputTokens;
    if (usage.cacheCreationInputTokens)
      session.tokenUsage.cacheCreationInputTokens =
        (session.tokenUsage.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
    if (usage.cacheReadInputTokens)
      session.tokenUsage.cacheReadInputTokens =
        (session.tokenUsage.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
    session.tokenUsage.totalTokens =
      session.tokenUsage.inputTokens + session.tokenUsage.outputTokens;
  }

  /**
   * Add cost to the active session.
   */
  addCost(cost: number): void {
    const session = this.getActive();
    session.totalCost += cost;
  }

  /**
   * Add a file to the modified-files list.
   */
  trackModifiedFile(filePath: string): void {
    const session = this.getActive();
    if (!session.metadata.filesModified!.includes(filePath)) {
      session.metadata.filesModified!.push(filePath);
    }
  }

  /**
   * Track a tool that was used.
   */
  trackTool(toolName: string): void {
    const session = this.getActive();
    if (!session.metadata.toolsUsed!.includes(toolName)) {
      session.metadata.toolsUsed!.push(toolName);
    }
  }

  /**
   * Track a spawned sub-agent in the active session's metadata.
   * Also writes an agent-metadata entry to the JSONL stream.
   */
  trackSubAgent(
    agentId: string,
    agentType?: string,
    prompt?: string,
    description?: string,
    toolUseId?: string,
  ): void {
    const session = this.getActive();
    if (!session.metadata.subAgentIds) {
      session.metadata.subAgentIds = [];
    }
    if (!session.metadata.subAgentIds.includes(agentId)) {
      session.metadata.subAgentIds.push(agentId);
    }

    // Write agent-metadata entry to JSONL
    const entry: SessionEntry = {
      type: 'agent-metadata',
      agentId,
      agentType: agentType ?? 'unknown',
      prompt: prompt ?? '',
      description,
      toolUseId,
      timestamp: Date.now(),
    } as SessionEntry;

    const dir = getSessionDir(session.id);
    const jsonlPath = sessionJsonlPath(dir);
    appendEntry(jsonlPath, entry).catch(() => {});
  }

  /**
   * Complete the active session.
   */
  complete(): void {
    const session = this.getActive();
    session.status = 'completed';
    session.completedAt = new Date();
    session.updatedAt = new Date();
    this.appendMetadata(session);
    this.activeSession = null;
  }

  /**
   * Pause the active session.
   */
  pause(): void {
    const session = this.getActive();
    session.status = 'paused';
    session.updatedAt = new Date();
    this.appendMetadata(session);
    this.activeSession = null;
  }

  /**
   * Mark the active session as error.
   */
  error(): void {
    const session = this.getActive();
    session.status = 'error';
    session.updatedAt = new Date();
    this.appendMetadata(session);
  }

  /**
   * Save the session metadata to JSONL.
   * Appends title entry (last-wins), does NOT rewrite messages.
   */
  saveSession(session: Session): void {
    this.appendMetadata(session);
  }

  /**
   * Re-append title and other metadata entries to the end of the JSONL
   * so they're visible in the tail read for session listing.
   */
  private appendMetadata(session: Session): void {
    const dir = getSessionDir(session.id);
    const jsonlPath = sessionJsonlPath(dir);

    const titleEntry: SessionEntry = {
      type: 'title',
      title: session.title,
    } as SessionEntry;

    appendEntry(jsonlPath, titleEntry).catch(() => {});
  }

  /**
   * Rebuild the entire JSONL file from the in-memory messages array.
   * Used after rewind or replaceMessages to keep the file consistent
   * with the compacted/truncated message set.
   */
  private rebuildJsonlFromSession(session: Session): void {
    const dir = getSessionDir(session.id);
    const jsonlPath = sessionJsonlPath(dir);

    const entries: SessionEntry[] = [];
    let prevUuid: string | null = null;

    for (const msg of session.messages) {
      const uuid = randomUUID();
      entries.push({
        type: msg.role as 'user' | 'assistant' | 'system',
        uuid,
        parentUuid: prevUuid,
        timestamp: Date.now(),
        message: msg,
      } as SessionEntry);
      prevUuid = uuid;
    }

    (session as any)._lastEntryUuid = prevUuid;

    entries.push({
      type: 'title',
      title: session.title,
    } as SessionEntry);

    rewriteEntries(jsonlPath, entries).catch(() => {});
  }

  /**
   * Flush all pending writes and exit the process.
   */
  async flushAndExit(code = 0): Promise<void> {
    if (this.pendingWrites.size > 0) {
      await Promise.all(Array.from(this.pendingWrites));
    }
    process.exit(code);
  }

  /**
   * Register SIGINT/SIGTERM handlers to flush writes before exit.
   */
  private registerExitHandler(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;

    if (IS_WINDOWS) {
      process.on('beforeExit', () => {
        this.flushAndExit(0);
      });
    } else {
      const handler = () => {
        this.flushAndExit(0);
      };
      process.once('SIGINT', handler);
      process.once('SIGTERM', handler);
    }
  }

  /**
   * List sessions matching a filter.
   * Uses fast tail reads of JSONL files instead of parsing full files.
   */
  list(filter?: SessionFilter): SessionSummary[] {
    const summaries: SessionSummary[] = [];

    let entries: string[];
    try {
      entries = readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }

    for (const id of entries) {
      const dir = getSessionDir(id);
      const jsonlPath = sessionJsonlPath(dir);

      // Skip directories without session.jsonl (legacy or empty)
      if (!existsSync(jsonlPath)) continue;

      // Fast path: read tail metadata from JSONL
      const { lastTitle, lastUserPreview, hasParent, transcriptEntryCount } = readTailMetadata(jsonlPath);

      // Skip sub-agent / workflow sessions (child sessions)
      if (hasParent) continue;

      // Skip sessions with no transcript entries (no actual conversation)
      if (transcriptEntryCount === 0) continue;

      // Approximate turnCount from transcript entries (one turn = user + assistant)
      const approxTurns = Math.floor(transcriptEntryCount / 2);

      const title = lastTitle ?? `Session ${id.slice(0, 8)}`;
      const mtime = statSync(jsonlPath).mtime;

      summaries.push({
        id,
        title,
        status: 'active' as const,
        turnCount: approxTurns,
        totalCost: 0,
        createdAt: mtime,
        updatedAt: mtime,
        model: lastUserPreview ?? 'unknown',
        lastUserPreview: lastUserPreview ?? undefined,
      });
    }

    // Sort by most recently updated (session IDs are random, use dir mtime)
    summaries.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    if (filter?.limit) {
      return summaries.slice(filter.offset ?? 0, (filter.offset ?? 0) + filter.limit);
    }
    return summaries;
  }

  /**
   * Continue the most recently updated session.
   */
  continueLatest(): Session {
    const sessions = this.list({ limit: 1 });
    if (sessions.length === 0) {
      throw new Error('No sessions found. Call create() first.');
    }
    return this.resume(sessions[0]!.id);
  }

  /**
   * List all sessions (convenience wrapper).
   */
  listSessions(limit?: number): SessionSummary[] {
    return this.list({ limit: limit ?? 50 });
  }

  /**
   * Delete a session and all its files.
   */
  delete(sessionId: string): boolean {
    const dir = getSessionDir(sessionId);

    if (!existsSync(dir)) return false;

    try {
      rmSync(dir, { recursive: true, force: true });
      this.sessions.delete(sessionId);
      if (this.activeSession?.id === sessionId) {
        this.activeSession = null;
      }
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Load a session from JSONL format.
   */
  private loadSession(id: string): Session | undefined {
    const dir = getSessionDir(id);
    const jsonlPath = sessionJsonlPath(dir);

    if (!existsSync(jsonlPath)) return undefined;

    return this.loadFromJsonl(id, dir, jsonlPath);
  }

  /**
   * Load session from JSONL format.
   */
  private loadFromJsonl(
    id: string,
    dir: string,
    jsonlPath: string,
  ): Session | undefined {
    try {
      const allEntries = readEntriesSync(jsonlPath);

      if (allEntries.length === 0) return undefined;

      // Extract messages from transcript entries
      const messages = entriesToMessages(allEntries);

      // Extract metadata from non-transcript entries (last-wins)
      let title: string | null = null;
      const subAgentIds: string[] = [];
      const filesModified: string[] = [];
      const toolsUsed: string[] = [];

      for (const entry of allEntries) {
        if (entry.type === 'title') {
          title = (entry as { title: string }).title;
        } else if (entry.type === 'agent-metadata') {
          const am = entry as { agentId: string };
          if (!subAgentIds.includes(am.agentId)) {
            subAgentIds.push(am.agentId);
          }
        }
      }

      const now = new Date();

      // Track the last entry's uuid for parentUuid chaining
      let lastUuid: string | null = null;
      for (let i = allEntries.length - 1; i >= 0; i--) {
        const e = allEntries[i]!;
        if (isTranscriptEntry(e)) {
          lastUuid = e.uuid;
          break;
        }
      }

      const session: Session = {
        id,
        title: title ?? `Session ${id.slice(0, 8)}`,
        status: 'active',
        messages,
        turnCount: messages.filter((m) => m.role === 'assistant').length,
        totalCost: 0,
        createdAt: now,
        updatedAt: now,
        cwd: process.cwd(),
        model: 'unknown',
        provider: 'anthropic',
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 0,
        },
        metadata: {
          filesModified,
          toolsUsed,
          tags: [],
          subAgentIds: subAgentIds.length > 0 ? subAgentIds : undefined,
        },
      };

      (session as any)._lastEntryUuid = lastUuid;
      (session as any)._entryCount = allEntries.length;

      return session;
    } catch {
      return undefined;
    }
  }
}
