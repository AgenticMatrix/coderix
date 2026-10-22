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

import { existsSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
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
  sessionSystemPromptPath,
  sessionMetaPath,
  appendEntry,
  appendEntrySync,
  readEntriesSync,
  rewriteEntries,
  entriesToMessages,
  readTailMetadata,
  readSessionMeta,
  writeSessionMeta,
  type SessionMeta,
  generateSessionTitle,
  isAutoTitle,
  stripCompactWrapper,
  isCompactSummaryText,
  readLastTranscriptUuidSync,
  rewriteTranscriptPreservingExternal,
  withSessionWriteLock,
  flushSessionWrites,
} from './session-store.js';
import {
  SessionBusyError,
  acquireLeaseSync,
  inspectLease,
  releaseLeaseSync,
  startLeaseHeartbeat,
  type SessionClient,
} from './session-lease.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessageText(message: Message): string {
  if (typeof message.content === 'string') return stripCompactWrapper(message.content);
  if (Array.isArray(message.content)) {
    return (message.content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(' ');
  }
  return '';
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private activeSession: Session | null = null;
  private sessions: Map<string, Session> = new Map();
  private pendingWrites = new Set<Promise<void>>();
  private exitHandlerRegistered = false;
  private readonly diskless: boolean;
  private readonly client: SessionClient;
  /** Stops the per-session lease heartbeat (desktop/CLI hold different leases). */
  private leaseHeartbeats = new Map<string, () => void>();

  constructor(diskless: boolean = false, client: SessionClient = 'unknown') {
    this.diskless = diskless;
    this.client = client;
    if (!diskless && !existsSync(SESSIONS_DIR)) {
      mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  // -------------------------------------------------------------------------
  // Write-ownership lease
  // -------------------------------------------------------------------------

  /**
   * Take (or renew) this process's lease on a session. When another live
   * process owns it, `throwOnBusy` decides between a hard error (explicit
   * resume) and proceeding (best-effort background writes).
   */
  private ensureLease(session: Session, throwOnBusy: boolean): void {
    if (this.diskless) return;
    const dir = getSessionDir(session.id);
    const { acquired, holder } = acquireLeaseSync(dir, {
      sessionId: session.id,
      client: this.client,
    });
    if (!acquired) {
      if (throwOnBusy) {
        if (holder) throw new SessionBusyError(session.id, holder);
        throw new Error(`Unable to acquire the write lease for session ${session.id}`);
      }
      return;
    }
    if (!this.leaseHeartbeats.has(session.id)) {
      this.leaseHeartbeats.set(
        session.id,
        startLeaseHeartbeat(dir, session.id, this.client),
      );
    }
  }

  private releaseLease(sessionId: string): void {
    const stop = this.leaseHeartbeats.get(sessionId);
    if (stop) {
      stop();
      this.leaseHeartbeats.delete(sessionId);
    }
    if (!this.diskless) {
      releaseLeaseSync(getSessionDir(sessionId), sessionId);
    }
  }

  private releaseAllLeases(): void {
    for (const id of Array.from(this.leaseHeartbeats.keys())) {
      this.releaseLease(id);
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
    agentType?: string;
    pluginId?: string;
    skills?: string[];
    mcpServers?: string[];
    /** Currency the session's price configuration is denominated in. */
    currency?: string;
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
      currency: options.currency,
      createdAt: now,
      updatedAt: now,
      cwd: options.cwd ?? process.cwd(),
      model: options.model ?? 'deepseek-v4-pro',
      provider: options.provider ?? 'anthropic',
      parentSessionId: options.parentSessionId,
      baseCommit: options.baseCommit,
      skills: options.skills,
      mcpServers: options.mcpServers,
      agentType: options.agentType,
      pluginId: options.pluginId,
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
    // No transcript file yet — a reload() must keep this in-memory session
    // instead of reporting "not found" before the first append.
    (session as any)._diskStamp = '';
    (session as any)._knownUuids = new Set<string>();

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
   * Get the active session without throwing — null when none is active.
   * Used by paths (e.g. QueryEngine.init) that must tolerate a missing session.
   */
  tryGetActive(): Session | null {
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
   * Resolve a session by id for a write operation, caching it from disk when
   * necessary. Throws if the session does not exist.
   */
  private requireSession(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.loadSession(sessionId);
      if (session) this.sessions.set(sessionId, session);
    }
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  /**
   * Adopt an existing session object into this manager as its active session
   * without writing to disk. Used by per-session managers so they share the
   * same in-memory Session object as the registry (single source of truth).
   */
  adopt(session: Session): void {
    this.sessions.set(session.id, session);
    this.activeSession = session;
  }

  /**
   * Bind a session to a model and persist it to meta.json so the session
   * remembers which model to use when resumed later.
   */
  setModel(sessionId: string, model: string): void {
    const session = this.requireSession(sessionId);
    session.model = model;
    session.updatedAt = new Date();
    const dir = getSessionDir(session.id);
    writeSessionMeta(dir, { model }).catch(() => {});
  }

  /** Bind the active session to a model (delegator — see setModel). */
  setActiveModel(model: string): void {
    this.setModel(this.getActive().id, model);
  }

  /**
   * Bind a session to the currency its price configuration is denominated in
   * and persist it to meta.json so a resumed session prices and formats cost
   * the same way it did when the turns were recorded.
   */
  setCurrency(sessionId: string, currency: string | undefined): void {
    const session = this.requireSession(sessionId);
    if (!currency || session.currency === currency) return;
    session.currency = currency;
    session.updatedAt = new Date();
    const dir = getSessionDir(session.id);
    writeSessionMeta(dir, { currency }).catch(() => {});
  }

  /**
   * Bind a session to a set of skills and persist them to meta.json so the
   * session remembers which skills to enable when resumed later.
   * An empty array explicitly means "no skills enabled".
   */
  setSkills(sessionId: string, skills: string[]): void {
    const session = this.requireSession(sessionId);
    session.skills = skills;
    session.updatedAt = new Date();
    const dir = getSessionDir(session.id);
    writeSessionMeta(dir, { skills }).catch(() => {});
  }

  /** Bind the active session to a set of skills (delegator — see setSkills). */
  setActiveSkills(skills: string[]): void {
    this.setSkills(this.getActive().id, skills);
  }

  /**
   * Bind a session to a set of enabled MCP server names and persist them to
   * meta.json so the session remembers which MCP tools to expose when resumed.
   * An empty array explicitly means "no MCP servers enabled".
   */
  setMcpServers(sessionId: string, mcpServers: string[]): void {
    const session = this.requireSession(sessionId);
    session.mcpServers = mcpServers;
    session.updatedAt = new Date();
    const dir = getSessionDir(session.id);
    writeSessionMeta(dir, { mcpServers }).catch(() => {});
  }

  /** Bind the active session to a set of MCP servers (delegator — see setMcpServers). */
  setActiveMcpServers(mcpServers: string[]): void {
    this.setMcpServers(this.getActive().id, mcpServers);
  }

  /**
   * Bind a session to a plugin agent identity and persist it to meta.json so the
   * session reopens as the same sub-agent plugin when resumed later.
   */
  setAgentType(sessionId: string, agentType: string, pluginId?: string): void {
    const session = this.requireSession(sessionId);
    session.agentType = agentType;
    if (pluginId !== undefined) session.pluginId = pluginId;
    session.updatedAt = new Date();
    const dir = getSessionDir(session.id);
    writeSessionMeta(dir, { agentType, ...(pluginId !== undefined ? { pluginId } : {}) }).catch(() => {});
  }

  /**
   * Bind a session to a working directory and persist it to meta.json so the
   * session reopens in that workspace when resumed later. Used to lazily mint a
   * conversation's hash subdir on the first message rather than on creation.
   */
  setCwd(sessionId: string, cwd: string): void {
    const session = this.requireSession(sessionId);
    session.cwd = cwd;
    session.updatedAt = new Date();
    const dir = getSessionDir(session.id);
    writeSessionMeta(dir, { workDir: cwd }).catch(() => {});
  }

  /**
   * Resume a session from disk.
   * Throws SessionBusyError when another live process is writing it.
   */
  resume(sessionId: string): Session {
    const inspection = inspectLease(getSessionDir(sessionId));
    if (inspection.busy && inspection.holder) {
      throw new SessionBusyError(sessionId, inspection.holder);
    }

    const session = this.sessions.has(sessionId)
      ? this.reload(sessionId)
      : this.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.ensureLease(session, true);

    session.status = 'active';
    session.updatedAt = new Date();

    this.sessions.set(sessionId, session);
    this.activeSession = session;

    // Re-append title to JSONL so it's in the tail for listing
    this.appendMetadata(session);

    return session;
  }

  /**
   * Resume a session for writing, copying it first when another client owns
   * the live conversation. A copy keeps the same history under a new id so
   * neither side's turns can be orphaned by the other's append.
   */
  resumeOrFork(sessionId: string): { session: Session; forkedFrom?: string } {
    if (this.activeSession?.id === sessionId) {
      const inspection = inspectLease(getSessionDir(sessionId));
      if (!inspection.busy) {
        this.ensureLease(this.activeSession, true);
        return { session: this.activeSession };
      }
    }

    try {
      return { session: this.resume(sessionId) };
    } catch (err) {
      if (!(err instanceof SessionBusyError)) throw err;
      const forked = this.fork({ sessionId });
      return { session: forked, forkedFrom: sessionId };
    }
  }

  /**
   * True when another live process owns this session's write lease.
   * Cheap: reads only the small lease file.
   */
  isBusy(sessionId: string): boolean {
    if (this.diskless) return false;
    return inspectLease(getSessionDir(sessionId)).busy;
  }

  /**
   * Cheap change detector for a transcript file. Used to decide whether a
   * cached session really needs to be re-read from disk — an unchanged file
   * means in-memory trims/compaction must not be undone.
   */
  private diskStamp(jsonlPath: string): string {
    try {
      const stat = statSync(jsonlPath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return '';
    }
  }

  /**
   * Refresh a cached session from disk. Keeps the cached object identity (so
   * per-session engines stay bound to the same instance) but replaces its
   * messages/metadata with what another process last wrote.
   */
  reload(sessionId: string): Session | undefined {
    const cached = this.sessions.get(sessionId);
    const jsonlPath = sessionJsonlPath(getSessionDir(sessionId));

    // Nothing changed on disk since this process last read/wrote it.
    if (cached && (cached as any)._diskStamp === this.diskStamp(jsonlPath)) {
      return cached;
    }

    const fresh = this.loadSession(sessionId);
    if (!fresh) return undefined;

    if (!cached) {
      this.sessions.set(sessionId, fresh);
      return fresh;
    }

    cached.title = fresh.title;
    cached.messages = fresh.messages;
    cached.turnCount = fresh.turnCount;
    cached.updatedAt = fresh.updatedAt;
    // Token counters and cost only grow within a session. A reload can race a
    // client whose meta snapshot predates the live totals held here — replacing
    // them with that stale (often all-zero) snapshot would blank the status
    // bar's usage until the next turn, so keep the higher of the two.
    const maxCounter = (current: number | undefined, disk: number | undefined): number =>
      Math.max(current ?? 0, disk ?? 0);
    const currentUsage = cached.tokenUsage;
    const diskUsage = fresh.tokenUsage;
    const inputTokens = maxCounter(currentUsage.inputTokens, diskUsage.inputTokens);
    const outputTokens = maxCounter(currentUsage.outputTokens, diskUsage.outputTokens);
    const cacheCreationInputTokens = maxCounter(
      currentUsage.cacheCreationInputTokens,
      diskUsage.cacheCreationInputTokens,
    );
    const cacheReadInputTokens = maxCounter(
      currentUsage.cacheReadInputTokens,
      diskUsage.cacheReadInputTokens,
    );
    cached.tokenUsage = {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    };
    cached.totalCost = Math.max(cached.totalCost, fresh.totalCost);
    cached.currency = fresh.currency;
    cached.cwd = fresh.cwd;
    cached.model = fresh.model;
    cached.skills = fresh.skills;
    cached.mcpServers = fresh.mcpServers;
    cached.agentType = fresh.agentType;
    cached.pluginId = fresh.pluginId;
    cached.contextTokens = fresh.contextTokens;
    cached.metadata = fresh.metadata;
    (cached as any)._lastEntryUuid = (fresh as any)._lastEntryUuid;
    (cached as any)._entryCount = (fresh as any)._entryCount;
    (cached as any)._knownUuids = (fresh as any)._knownUuids;
    (cached as any)._diskStamp = (fresh as any)._diskStamp;

    if (this.activeSession?.id === sessionId) {
      this.activeSession = cached;
    }
    return cached;
  }

  /**
   * Fork a session — create a new session from the parent's messages up to a turn.
   * The new session gets its own copy of the transcript so both sides can
   * continue independently (used when another client owns the live session).
   */
  fork(options: { sessionId: string; fromTurn?: number; cwd?: string }): Session {
    // Prefer the freshest on-disk snapshot: a copy is usually created because
    // another client owns the live conversation, and its latest turns matter.
    const parent = this.sessions.has(options.sessionId)
      ? this.reload(options.sessionId)
      : this.get(options.sessionId);
    if (!parent) {
      throw new Error(`Parent session not found: ${options.sessionId}`);
    }

    const messages = options.fromTurn
      ? parent.messages.slice(0, options.fromTurn)
      : [...parent.messages];

    const forked = this.create({
      title: `${parent.title} (fork)`,
      cwd: options.cwd ?? parent.cwd,
      model: parent.model,
      provider: parent.provider,
      parentSessionId: parent.id,
      baseCommit: parent.baseCommit,
      // A copy must keep the conversation's identity, otherwise a plugin
      // session would reopen on the wrong engine (and lose its skills/MCP).
      skills: parent.skills,
      mcpServers: parent.mcpServers,
      agentType: parent.agentType,
      pluginId: parent.pluginId,
      currency: parent.currency,
    });

    const dir = getSessionDir(forked.id);
    const jsonlPath = sessionJsonlPath(dir);
    const known = new Set<string>();
    let prev: string | null = null;

    if (!this.diskless) {
      for (const message of messages) {
        const uuid = randomUUID();
        appendEntrySync(jsonlPath, {
          type: message.role,
          uuid,
          parentUuid: prev,
          timestamp: Date.now(),
          message,
        } as SessionEntry);
        known.add(uuid);
        prev = uuid;
      }
    }

    forked.messages = messages;
    forked.turnCount = messages.filter((m) => m.role === 'assistant').length;
    (forked as any)._lastEntryUuid = prev;
    (forked as any)._entryCount = messages.length;
    (forked as any)._knownUuids = known;
    (forked as any)._diskStamp = this.diskStamp(jsonlPath);
    // A user-facing fork is a normal, listable conversation — it must not be
    // mistaken for a sub-agent child session (those are hidden from listings).
    (forked as any)._isCopy = true;

    writeSessionMeta(dir, {
      title: forked.title,
      workDir: forked.cwd,
      model: forked.model,
      skills: forked.skills,
      mcpServers: forked.mcpServers,
      agentType: forked.agentType,
      ...(forked.pluginId ? { pluginId: forked.pluginId } : {}),
    }).catch(() => {});

    this.ensureLease(forked, false);
    this.appendMetadata(forked);

    return forked;
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
  trimMessages(maxTokens: number, minKeep?: number): number;
  trimMessages(sessionId: string, maxTokens: number, minKeep?: number): number;
  trimMessages(sessionIdOrMaxTokens: string | number, maxTokensOrMinKeep?: number, minKeep = 10): number {
    const session = typeof sessionIdOrMaxTokens === 'string'
      ? this.requireSession(sessionIdOrMaxTokens)
      : this.getActive();
    const maxTokens = typeof sessionIdOrMaxTokens === 'string'
      ? (maxTokensOrMinKeep as number)
      : sessionIdOrMaxTokens;
    const minKeepFinal = typeof sessionIdOrMaxTokens === 'string'
      ? (minKeep ?? 10)
      : (maxTokensOrMinKeep ?? 10);
    const totalTokens = tokenCountWithEstimation(session.messages);
    if (totalTokens <= maxTokens) return 0;

    const maxDrop = session.messages.length - minKeepFinal;
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
   * Replace a session's messages with a compacted set.
   * Archives the old transcript to history_transcript/ before rewriting.
   * Returns the archive path for inclusion in the compact summary.
   */
  replaceMessages(messages: Message[]): string | undefined;
  replaceMessages(sessionId: string, messages: Message[]): string | undefined;
  replaceMessages(sessionIdOrMessages: string | Message[], maybeMessages?: Message[]): string | undefined {
    const session = typeof sessionIdOrMessages === 'string'
      ? this.requireSession(sessionIdOrMessages)
      : this.getActive();
    const messages = typeof sessionIdOrMessages === 'string'
      ? (maybeMessages as Message[])
      : sessionIdOrMessages;
    session.messages = [...messages];
    session.updatedAt = new Date();
    // Archive old JSONL before rebuilding
    const archivePath = this.archiveTranscript(session);
    // Rebuild JSONL from compacted messages
    this.rebuildJsonlFromSession(session);
    return archivePath;
  }

  /**
   * Strip every `thinking` block from the active session's history.
   *
   * Thinking blocks are signed by the provider that produced them and cannot
   * round-trip across providers — a cross-provider model switch that replays
   * stale blocks gets rejected (e.g. DeepSeek's Anthropic-compatible endpoint
   * returns 400 "The content[].thinking … must be passed back"). Called on a
   * cross-provider switch (after the renderer warns the user) so the new
   * provider never sees the old provider's thinking blocks.
   *
   * Returns the number of thinking blocks removed.
   */
  stripThinking(): number;
  stripThinking(sessionId: string): number;
  stripThinking(sessionId?: string): number {
    const session = sessionId !== undefined ? this.requireSession(sessionId) : this.getActive();
    let removed = 0;
    for (const msg of session.messages) {
      if (!Array.isArray(msg.content)) continue;
      const before = msg.content.length;
      msg.content = msg.content.filter((block) => block.type !== 'thinking');
      removed += before - msg.content.length;
    }
    if (removed > 0) {
      session.updatedAt = new Date();
      this.rebuildJsonlFromSession(session);
    }
    return removed;
  }

  /**
   * Archive the current session.jsonl to history_transcript/transcript-{ts}.jsonl.
   * Returns the archive path or undefined if the source file doesn't exist.
   */
  private archiveTranscript(session: Session): string | undefined {
    const dir = getSessionDir(session.id);
    const jsonlPath = sessionJsonlPath(dir);
    if (!existsSync(jsonlPath)) return undefined;

    const historyDir = `${dir}/history_transcript`;
    mkdirSync(historyDir, { recursive: true, mode: 0o700 });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = `${historyDir}/transcript-${ts}.jsonl`;
    copyFileSync(jsonlPath, archivePath);
    return archivePath;
  }

  // Hard cap on in-memory messages to prevent unbounded heap growth.
  // Token-based trimming (contextBudget / 2) is the primary limiter;
  // this count-based cap is a secondary safety net.
  private static readonly MAX_MESSAGES = 300;

  /**
   * Add a message to a session (active when called with one arg).
   * Appends to JSONL file AND updates in-memory messages array.
   */
  addMessage(message: Message): void;
  addMessage(sessionId: string, message: Message): void;
  addMessage(sessionIdOrMessage: string | Message, maybeMessage?: Message): void {
    const session = typeof sessionIdOrMessage === 'string'
      ? this.requireSession(sessionIdOrMessage)
      : this.getActive();
    const message = typeof sessionIdOrMessage === 'string'
      ? (maybeMessage as Message)
      : sessionIdOrMessage;

    // Chain position is resolved against the on-disk tail inside the write
    // lock below, so a second writer (or a stale cache) can never fork the
    // parentUuid chain. In-memory state updates synchronously.
    const isFirstEntry = (((session as any)._entryCount as number) ?? 0) === 0;

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

    // Update in-memory title from the first user message (always)
    if (isFirstEntry) {
      if (message.role === 'user') {
        const text = extractMessageText(message);
        if (text) {
          session.title = generateSessionTitle(text);
        }
      }
      (session as any)._entryCount = 1;
    }

    (session as any)._entryCount = ((session as any)._entryCount as number) + 1;

    // Append to JSONL asynchronously. Every write is queued and tracked so
    // flush() can drain the transcript before another client reads it.
    // Skip when diskless — sub-agent sessions are in-memory only.
    if (!this.diskless) {
      const dir = getSessionDir(session.id);
      const known: Set<string> =
        (session as any)._knownUuids ??= new Set<string>();

      this.ensureLease(session, false);

      const writePromise = withSessionWriteLock(dir, async () => {
        const jsonlPath = sessionJsonlPath(dir);

        // Bootstrap the session on first message: write parent metadata and workDir
        if (isFirstEntry) {
          // A forked copy is a normal conversation, not a sub-agent child.
          if (session.parentSessionId && !(session as any)._isCopy) {
            await appendEntry(jsonlPath, {
              type: 'parent-session',
              parentSessionId: session.parentSessionId,
            } as SessionEntry);
          }
          // Persist workDir + model on first write so session listing/resume
          // can restore the workspace and the model the session was created with.
          writeSessionMeta(dir, { workDir: session.cwd, model: session.model }).catch(() => {});
        }

        const parentUuid = readLastTranscriptUuidSync(jsonlPath);
        const uuid = randomUUID();
        await appendEntry(jsonlPath, {
          type: message.role as 'user' | 'assistant' | 'system',
          uuid,
          parentUuid,
          timestamp: Date.now(),
          message,
        } as SessionEntry);

        (session as any)._lastEntryUuid = uuid;
        known.add(uuid);
        (session as any)._diskStamp = this.diskStamp(jsonlPath);
      }).catch((err) => {
        console.error(`[session] Failed to append message to ${session.id}:`, err);
      });

      this.pendingWrites.add(writePromise);
      writePromise
        .finally(() => {
          this.pendingWrites.delete(writePromise);
        })
        .catch(() => {});
    }
  }

  /**
   * Update token usage for the active session.
   */
  updateUsage(usage: Partial<TokenUsageSummary>): void;
  updateUsage(sessionId: string, usage: Partial<TokenUsageSummary>): void;
  updateUsage(sessionIdOrUsage: string | Partial<TokenUsageSummary>, maybeUsage?: Partial<TokenUsageSummary>): void {
    const session = typeof sessionIdOrUsage === 'string'
      ? this.requireSession(sessionIdOrUsage)
      : this.getActive();
    const usage = typeof sessionIdOrUsage === 'string'
      ? (maybeUsage as Partial<TokenUsageSummary>)
      : sessionIdOrUsage;
    if (usage.inputTokens) session.tokenUsage.inputTokens += usage.inputTokens;
    if (usage.outputTokens) session.tokenUsage.outputTokens += usage.outputTokens;
    if (usage.cacheCreationInputTokens)
      session.tokenUsage.cacheCreationInputTokens =
        (session.tokenUsage.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
    if (usage.cacheReadInputTokens)
      session.tokenUsage.cacheReadInputTokens =
        (session.tokenUsage.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens;
    session.tokenUsage.totalTokens =
      session.tokenUsage.inputTokens +
      session.tokenUsage.outputTokens +
      (session.tokenUsage.cacheCreationInputTokens ?? 0) +
      (session.tokenUsage.cacheReadInputTokens ?? 0);
  }

  /**
   * Add cost to the active session.
   */
  addCost(cost: number): void;
  addCost(sessionId: string, cost: number): void;
  addCost(sessionIdOrCost: string | number, maybeCost?: number): void {
    const session = typeof sessionIdOrCost === 'string'
      ? this.requireSession(sessionIdOrCost)
      : this.getActive();
    const cost = typeof sessionIdOrCost === 'string'
      ? (maybeCost as number)
      : sessionIdOrCost;
    session.totalCost += cost;
  }

  /**
   * Add a file to the modified-files list.
   */
  trackModifiedFile(filePath: string): void;
  trackModifiedFile(sessionId: string, filePath: string): void;
  trackModifiedFile(sessionIdOrFilePath: string, maybeFilePath?: string): void {
    const session = maybeFilePath !== undefined
      ? this.requireSession(sessionIdOrFilePath)
      : this.getActive();
    const filePath = maybeFilePath ?? sessionIdOrFilePath;
    if (!session.metadata.filesModified!.includes(filePath)) {
      session.metadata.filesModified!.push(filePath);
    }
  }

  /**
   * Track a tool that was used.
   */
  trackTool(toolName: string): void;
  trackTool(sessionId: string, toolName: string): void;
  trackTool(sessionIdOrToolName: string, maybeToolName?: string): void {
    const session = maybeToolName !== undefined
      ? this.requireSession(sessionIdOrToolName)
      : this.getActive();
    const toolName = maybeToolName ?? sessionIdOrToolName;
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
    this.releaseLease(session.id);
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
    this.releaseLease(session.id);
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
   * Write session metadata to meta.json for session listing.
   */
  private appendMetadata(session: Session): void {
    const dir = getSessionDir(session.id);
    // Omit an absent currency instead of writing `undefined`: the meta write
    // merges over the existing file, so an explicit undefined would erase the
    // currency another process just persisted.
    const meta: SessionMeta = {
      title: session.title,
      workDir: session.cwd,
      model: session.model,
      totalCost: session.totalCost,
      tokenUsage: session.tokenUsage,
    };
    if (session.currency) meta.currency = session.currency;
    writeSessionMeta(dir, meta).catch(() => {});
  }

  /**
   * Rebuild the entire JSONL file from the in-memory messages array.
   * Used after rewind or replaceMessages to keep the file consistent
   * with the compacted/truncated message set.
   */
  private rebuildJsonlFromSession(session: Session): void {
    const dir = getSessionDir(session.id);

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

    const newUuids = new Set(
      entries.filter(isTranscriptEntry).map((e) => e.uuid),
    );
    const known: Set<string> =
      (session as any)._knownUuids ?? new Set<string>();

    // Entries appended by another client while this process was compacting are
    // re-chained onto the new tail instead of being overwritten.
    const writePromise = rewriteTranscriptPreservingExternal(dir, entries, known)
      .then(({ tailUuid, externalCount, externalUuids }) => {
        (session as any)._lastEntryUuid = tailUuid;
        const next = new Set(newUuids);
        for (const uuid of externalUuids) next.add(uuid);
        (session as any)._knownUuids = next;
        (session as any)._diskStamp = this.diskStamp(sessionJsonlPath(dir));
        if (externalCount > 0) {
          console.warn(
            `[session] Preserved ${externalCount} externally appended entr${externalCount === 1 ? 'y' : 'ies'} while rewriting ${session.id}`,
          );
        }
      })
      .catch((err) => {
        console.error(`[session] Failed to rewrite transcript ${session.id}:`, err);
      });

    this.pendingWrites.add(writePromise);
    writePromise
      .finally(() => {
        this.pendingWrites.delete(writePromise);
      })
      .catch(() => {});
  }

  /**
   * Flush all pending writes WITHOUT exiting. Used to drain per-session
   * managers' pending JSONL writes before the registry's single exit handler
   * calls process.exit, so parallel sessions never truncate their transcripts.
   */
  async flush(): Promise<void> {
    if (this.pendingWrites.size > 0) {
      await Promise.all(Array.from(this.pendingWrites));
    }
    // Also drain writes queued by per-session managers (desktop engines) that
    // share this session object but not this instance's pendingWrites set.
    await flushSessionWrites();
  }

  /**
   * Flush all pending writes and exit the process.
   */
  async flushAndExit(code = 0): Promise<void> {
    await this.flush();
    this.releaseAllLeases();
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
   * Build a single session summary from its on-disk directory.
   * Returns null if the session is missing, empty, or a child session.
   */
  private buildSummaryFromDir(id: string): SessionSummary | null {
    const dir = getSessionDir(id);
    const jsonlPath = sessionJsonlPath(dir);

    // Skip directories without session.jsonl (legacy or empty)
    if (!existsSync(jsonlPath)) return null;

    // Fast path: read tail metadata from JSONL
    const { lastTitle, lastUserPreview, firstUserText, hasParent, transcriptEntryCount } = readTailMetadata(jsonlPath);

    // Skip sub-agent / workflow sessions (child sessions)
    if (hasParent) return null;

    // Skip sessions with no transcript entries (no actual conversation)
    if (transcriptEntryCount === 0) return null;

    // Approximate turnCount from transcript entries (one turn = user + assistant)
    const approxTurns = Math.floor(transcriptEntryCount / 2);

    // Read title from meta.json (new), fall back to session.jsonl title entry (legacy)
    const meta = readSessionMeta(dir);
    // A persisted "Session <id>" or "..." placeholder carries no real signal —
    // treat it as absent so the picker regenerates a meaningful title from the
    // first user message instead of showing a bare session id.
    const metaTitle = meta?.title && !isAutoTitle(meta.title) ? meta.title : undefined;
    const generatedTitle = firstUserText ? generateSessionTitle(firstUserText) : undefined;
    const title = metaTitle ?? lastTitle ?? generatedTitle ?? `Session ${id.slice(0, 8)}`;
    const mtime = statSync(jsonlPath).mtime;

    // Compute display title for the session picker
    let displayTitle: string | undefined;
    if (metaTitle) {
      // meta.json has a real (non-placeholder) title — use it directly.
      displayTitle = metaTitle;
    } else if (generatedTitle) {
      // Placeholder / legacy title — generate from the first user text.
      displayTitle = generatedTitle;
    }

    return {
      id,
      title,
      status: 'active' as const,
      turnCount: approxTurns,
      totalCost: 0,
      createdAt: mtime,
      updatedAt: mtime,
      model: meta?.model ?? 'unknown',
      lastUserPreview: lastUserPreview ?? undefined,
      displayTitle,
      firstUserText: firstUserText ?? undefined,
      workDir: meta?.workDir,
      agentType: meta?.agentType,
      pluginId: meta?.pluginId,
      busy: inspectLease(dir).busy,
    };
  }

  /**
   * Build a summary for a session that exists only in this process's memory.
   *
   * `create()` deliberately defers the first disk write until the first
   * message, so a freshly created conversation has no session.jsonl yet.
   * Listing only the disk would hide it — and any full list reload (switching
   * workspace, opening the sidebar, a renderer reload) would drop it from the
   * sidebar until the app restarted. The creating process already knows the
   * session, so its list must include it.
   */
  private buildSummaryFromMemory(session: Session): SessionSummary {
    let firstUserText: string | undefined;
    let lastUserPreview: string | undefined;
    for (const message of session.messages) {
      if (message.role !== 'user') continue;
      const text = extractMessageText(message);
      if (!text || isCompactSummaryText(text)) continue;
      if (!firstUserText) firstUserText = text;
      lastUserPreview = text.length > 60 ? text.slice(0, 60) + '...' : text;
    }

    return {
      id: session.id,
      title: session.title,
      status: session.status,
      turnCount: session.turnCount,
      totalCost: session.totalCost,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
      lastUserPreview,
      displayTitle: session.title,
      firstUserText,
      workDir: session.cwd,
      agentType: session.agentType,
      pluginId: session.pluginId,
      busy: this.isBusy(session.id),
    };
  }

  /**
   * Whether an in-memory session may still appear as a top-level list entry.
   *
   * A session that has completed at least one disk write but whose directory is
   * now gone was deleted by another client (or by cleanup); the process cache
   * must not resurrect it. A session with no completed write is either brand
   * new or has workspace metadata only, and must stay visible.
   */
  private isInMemorySessionListable(session: Session): boolean {
    // A sub-agent child lives in its parent's transcript, never as a top-level
    // list entry. Forked copies set `_isCopy` and are real conversations.
    if (session.parentSessionId && !(session as any)._isCopy) return false;
    const everPersisted = Boolean((session as any)._diskStamp);
    if (everPersisted && !existsSync(getSessionDir(session.id))) return false;
    return true;
  }

  /**
   * Get a single session summary by ID without listing all sessions.
   * Returns null when the session no longer exists or is a child session.
   * Falls back to the in-memory session when it has not been written to disk.
   */
  getSummary(id: string): SessionSummary | null {
    const fromDisk = this.buildSummaryFromDir(id);
    if (fromDisk) return fromDisk;

    const inMemory = this.sessions.get(id);
    if (!inMemory || !this.isInMemorySessionListable(inMemory)) return null;
    return this.buildSummaryFromMemory(inMemory);
  }

  /**
   * List sessions matching a filter.
   * Uses fast tail reads of JSONL files instead of parsing full files, then
   * merges sessions that only exist in this process's memory (created but not
   * yet persisted — see `buildSummaryFromMemory`).
   *
   * `strict` makes an unreadable sessions root throw instead of degrading to
   * an empty list. The desktop's list endpoint uses it so a transient FS error
   * cannot wipe the sidebar; other callers keep the tolerant, best-effort
   * behavior they were written against.
   */
  list(
    filter?: SessionFilter,
    options: { strict?: boolean } = {},
  ): SessionSummary[] {
    let entries: string[];
    try {
      entries = readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        entries = [];
      } else if (options.strict) {
        throw err;
      } else {
        // Best-effort callers (CLI/TUI pickers) should not crash on a
        // temporarily unreadable root.
        console.error('[session] Failed to read sessions directory:', err);
        entries = [];
      }
    }

    const summaries = new Map<string, SessionSummary>();
    for (const id of entries) {
      try {
        const summary = this.buildSummaryFromDir(id);
        if (summary) summaries.set(id, summary);
      } catch (err) {
        // One unreadable/mid-write session directory must not take down the
        // whole list.
        console.error(`[session] Skipping unreadable session ${id}:`, err);
      }
    }

    // Merge sessions created by this process that have not reached disk yet.
    // Disk summaries win when both exist (they are the shared, durable view).
    for (const [id, session] of this.sessions) {
      if (summaries.has(id)) continue;
      if (!this.isInMemorySessionListable(session)) continue;
      summaries.set(id, this.buildSummaryFromMemory(session));
    }

    const list = Array.from(summaries.values());

    // Sort by most recently updated (session IDs are random, use dir mtime)
    list.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    if (filter?.limit) {
      return list.slice(filter.offset ?? 0, (filter.offset ?? 0) + filter.limit);
    }
    return list;
  }

  /**
   * Continue the most recently updated session that no other live client is
   * writing. `--continue` must not attach to a conversation the desktop is
   * still streaming into.
   */
  continueLatest(): Session {
    const sessions = this.list({ limit: 50 });
    if (sessions.length === 0) {
      throw new Error('No sessions found. Call create() first.');
    }
    const target = sessions.find((s) => !s.busy);
    if (!target) {
      throw new Error('All recent sessions are in use by another client.');
    }
    return this.resume(target.id);
  }

  /**
   * List all sessions (convenience wrapper).
   */
  listSessions(
    limit?: number,
    options: { strict?: boolean } = {},
  ): SessionSummary[] {
    return this.list({ limit: limit ?? 50 }, options);
  }

  /**
   * Write the system prompt to the active session's directory as system_prompt.md.
   * No-op if there is no active session or the session has no messages yet
   * (avoids creating empty directories for placeholder sessions).
   */
  writeSystemPrompt(text: string): void {
    const session = this.activeSession;
    if (!session || session.messages.length === 0) return;
    const dir = getSessionDir(session.id);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(sessionSystemPromptPath(dir), text, 'utf-8');
    } catch { /* best-effort */ }
  }

  /**
   * Delete a session and all its files.
   */
  delete(sessionId: string): boolean {
    const dir = getSessionDir(sessionId);

    // Evict from this process's cache first. A conversation created but not yet
    // written has no directory, and must still disappear from list() after the
    // user deletes it; list() merges in-memory sessions, so leaving it cached
    // would resurrect the row on the next reload.
    this.releaseLease(sessionId);
    this.sessions.delete(sessionId);
    if (this.activeSession?.id === sessionId) {
      this.activeSession = null;
    }

    if (!existsSync(dir)) return false;

    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up incomplete session directories.
   * Removes sessions that lack session.jsonl or have no assistant entry in it.
   * Returns the number of deleted sessions.
   */
  /**
   * Clean up incomplete session directories.
   *
   * Removes sessions that lack session.jsonl or have no assistant entry in it.
   * A session another live client owns, or one written within `minAgeMs`, is
   * never touched: its first assistant reply may still be streaming from a
   * concurrent CLI/desktop turn.
   *
   * Returns the number of deleted sessions.
   */
  cleanupIncompleteSessions(options: { minAgeMs?: number } = {}): number {
    const minAgeMs = options.minAgeMs ?? 10 * 60_000;
    const now = Date.now();
    let entries: string[];
    try {
      entries = readdirSync(SESSIONS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return 0;
    }

    let deleted = 0;
    for (const id of entries) {
      const dir = getSessionDir(id);
      const jsonlPath = sessionJsonlPath(dir);

      if (inspectLease(dir).busy) continue;

      let newestMtime = 0;
      try {
        newestMtime = statSync(existsSync(jsonlPath) ? jsonlPath : dir).mtimeMs;
      } catch {
        continue;
      }
      if (now - newestMtime < minAgeMs) continue;

      if (!existsSync(jsonlPath)) {
        // No session.jsonl — incomplete session, remove directory
        this.delete(id);
        deleted++;
        continue;
      }

      const meta = readTailMetadata(jsonlPath);
      if (!meta.hasAssistantEntry) {
        // Has session.jsonl but no assistant response — incomplete, remove
        this.delete(id);
        deleted++;
      }
    }

    return deleted;
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

      // First user message text — used to derive a title when none is stored.
      // Skip the compactor's synthetic continuation message so a compacted
      // session's title doesn't collapse to "This session is being continued…".
      const firstUserMessage = messages.find(
        (m) => m.role === 'user' && !isCompactSummaryText(extractMessageText(m)),
      );
      const firstUserText = firstUserMessage
        ? extractMessageText(firstUserMessage)
        : '';

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

      // Fall back to meta.json title (LLM-summarized titles are stored there).
      // Ignore persisted placeholders ("Session <id>"/"...") — they carry no
      // real signal and would otherwise lock a placeholder in on resume.
      const meta = readSessionMeta(dir);
      if (!title && meta?.title && !isAutoTitle(meta.title)) {
        title = meta.title;
      }

      const persistedContextLength = meta?.contextLength ?? 0;

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
        title:
          title ??
          (firstUserText
            ? generateSessionTitle(firstUserText)
            : `Session ${id.slice(0, 8)}`),
        status: 'active',
        messages,
        turnCount: messages.filter((m) => m.role === 'assistant').length,
        totalCost: meta?.totalCost ?? 0,
        currency: meta?.currency,
        createdAt: now,
        updatedAt: now,
        cwd: meta?.workDir ?? process.cwd(),
        model: meta?.model ?? 'unknown',
        provider: 'anthropic',
        skills: meta?.skills ?? [],
        mcpServers: meta?.mcpServers ?? [],
        agentType: meta?.agentType,
        pluginId: meta?.pluginId,
        tokenUsage: meta?.tokenUsage ?? {
          inputTokens: persistedContextLength,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: persistedContextLength,
        },
        contextTokens: meta?.contextTokens,
        metadata: {
          filesModified,
          toolsUsed,
          tags: [],
          subAgentIds: subAgentIds.length > 0 ? subAgentIds : undefined,
        },
      };

      (session as any)._lastEntryUuid = lastUuid;
      (session as any)._entryCount = allEntries.length;
      (session as any)._knownUuids = new Set(
        allEntries.filter(isTranscriptEntry).map((e) => e.uuid),
      );
      (session as any)._diskStamp = this.diskStamp(jsonlPath);

      return session;
    } catch {
      return undefined;
    }
  }
}
