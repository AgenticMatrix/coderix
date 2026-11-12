/**
 * session-lease.ts — cross-process write ownership for a session.
 *
 * A session transcript is append-only and reconstructed by walking a single
 * parentUuid chain. That only works when one process writes it at a time:
 * two writers each chain from their own in-memory tail, producing two leaves,
 * and the loader can only replay one of them (the other turn "disappears").
 *
 * This module gives a session a small lease file (`<sessionDir>/.lease.json`)
 * so a second client can detect that the conversation is already live
 * elsewhere and copy it instead of writing into it.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';

export type SessionClient = 'cli' | 'desktop' | 'unknown';

export interface SessionLease {
  sessionId: string;
  pid: number;
  host: string;
  client: SessionClient;
  startedAt: number;
  heartbeatAt: number;
  /**
   * Start time of `pid` (epoch ms) when the lease was taken. A live pid whose
   * start time differs is a different process that inherited the pid after the
   * writer died — see {@link isRecycledPid}. Absent on legacy leases.
   */
  procStart?: number;
}

export interface LeaseInspection {
  /** Another live process owns this session. Same-process re-entry is allowed. */
  busy: boolean;
  /** The lease belongs to this process (any SessionManager instance). */
  sameProcess: boolean;
  holder: SessionLease | null;
}

export class SessionBusyError extends Error {
  readonly code = 'SESSION_BUSY';
  readonly sessionId: string;
  readonly holder: SessionLease;

  constructor(sessionId: string, holder: SessionLease) {
    super(
      `Session ${sessionId} is in use by ${holder.client} (pid ${holder.pid}). ` +
        'Open a copy instead of writing to the live conversation.',
    );
    this.name = 'SessionBusyError';
    this.sessionId = sessionId;
    this.holder = holder;
  }
}

const LEASE_FILE = '.lease.json';
/** Atomic mutex directory used while check-and-write races with the other process. */
const MUTEX_DIR = '.lease.mutex';
/** A held mutex older than this is assumed abandoned (crashed mid-acquire). */
const MUTEX_STALE_MS = 10_000;
/** Heartbeat age that marks a foreign-host lease as live. */
const HEARTBEAT_STALE_MS = 5 * 60_000;
export const LEASE_HEARTBEAT_MS = 20_000;

export function leasePath(sessionDir: string): string {
  return join(sessionDir, LEASE_FILE);
}

export function readLease(sessionDir: string): SessionLease | null {
  const file = leasePath(sessionDir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SessionLease>;
    if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') return null;
    return {
      sessionId: raw.sessionId,
      pid: raw.pid,
      host: raw.host ?? '',
      client: (raw.client as SessionClient) ?? 'unknown',
      startedAt: raw.startedAt ?? 0,
      heartbeatAt: raw.heartbeatAt ?? 0,
      ...(typeof raw.procStart === 'number' ? { procStart: raw.procStart } : {}),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process liveness
// ---------------------------------------------------------------------------

/**
 * Cache of pid → process start time (epoch ms). One batched `ps` call fills it
 * for every visible process, so checking a directory of sessions does not spawn
 * one subprocess per lease. `null` marks a pid `ps` could not resolve.
 */
let procStartCache: { at: number; map: Map<number, number> } | null = null;
const PROC_START_CACHE_MS = 30_000;

function readProcessStartTimes(): Map<number, number> {
  if (procStartCache && Date.now() - procStartCache.at < PROC_START_CACHE_MS) {
    return procStartCache.map;
  }
  const map = new Map<number, number>();
  try {
    // `LC_ALL=C` keeps lstart in the fixed `Ddd Mmm D HH:MM:SS YYYY` shape that
    // Date.parse understands; a localized month name would parse to NaN.
    const out = execFileSync('ps', ['-axo', 'pid=,lstart='], {
      encoding: 'utf-8',
      env: { ...process.env, LC_ALL: 'C' },
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    for (const line of out.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
      if (!match) continue;
      const started = Date.parse(match[2]);
      if (Number.isFinite(started)) map.set(Number(match[1]), started);
    }
  } catch {
    // `ps` unavailable or timed out. Return what we have without caching it, so
    // one failed probe does not poison the check for the whole cache window.
    return map;
  }
  procStartCache = { at: Date.now(), map };
  return map;
}

/**
 * Start time of a pid, or null when it cannot be determined. `ps` reports whole
 * seconds, so callers must allow ~1s of slack when comparing.
 */
export function processStartTime(pid: number): number | null {
  const map = readProcessStartTimes();
  return map.get(pid) ?? null;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM means a process with this pid exists but belongs to another user.
    // Coderix clients only ever run as the current user, so a foreign-owned pid
    // is proof this lease's writer died and the pid was handed to someone else.
    // (Treating it as alive locked sessions forever after a reboot: pid 743 came
    // back as root's `appleeventsd` and every message forked a copy.)
    return false;
  }
}

/** Slack allowed when comparing `ps` start times (whole-second resolution). */
const PROC_START_TOLERANCE_MS = 2_000;

/**
 * True when `pid` is alive but started at a different time than the lease
 * recorded — the writer died and the OS reused its pid. Without this, a recycled
 * same-user pid would keep a conversation locked indefinitely, because
 * `process.kill(pid, 0)` succeeds for the impostor.
 */
function isRecycledPid(lease: SessionLease): boolean {
  if (lease.procStart === undefined) return false;
  const actual = processStartTime(lease.pid);
  // Unknown start time (ps unavailable) — do not block the session on a guess.
  if (actual === null) return false;
  return Math.abs(actual - lease.procStart) > PROC_START_TOLERANCE_MS;
}

function isLeaseLive(lease: SessionLease): boolean {
  if (lease.host === hostname()) {
    // Same machine: pid liveness is authoritative. Heartbeats are skipped
    // while the host sleeps, so trusting them alone would yield false negatives.
    return isProcessAlive(lease.pid) && !isRecycledPid(lease);
  }
  // Cannot probe a pid on another machine (shared home directory); fall back
  // to the heartbeat so a synced lease eventually expires.
  return Date.now() - lease.heartbeatAt < HEARTBEAT_STALE_MS;
}

export function inspectLease(sessionDir: string): LeaseInspection {
  const holder = readLease(sessionDir);
  if (!holder) return { busy: false, sameProcess: false, holder: null };
  const sameProcess = holder.pid === process.pid;
  return {
    busy: !sameProcess && isLeaseLive(holder),
    sameProcess,
    holder,
  };
}

function sleepSync(ms: number): void {
  // Node allows Atomics.wait on the main thread (unlike browsers).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireMutex(sessionDir: string): boolean {
  const mutex = join(sessionDir, MUTEX_DIR);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(mutex, { mode: 0o700 });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      try {
        if (Date.now() - statSync(mutex).mtimeMs > MUTEX_STALE_MS) {
          rmSync(mutex, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(10);
    }
  }
  return false;
}

function releaseMutex(sessionDir: string): void {
  try {
    rmSync(join(sessionDir, MUTEX_DIR), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Try to take ownership of a session for this process.
 *
 * Re-entrant for the same pid so multiple SessionManager instances inside one
 * process (desktop registry + per-session managers) can share a conversation.
 * Returns `acquired: false` with the current holder when another live process
 * owns it.
 */
export function acquireLeaseSync(
  sessionDir: string,
  options: {
    sessionId: string;
    client?: SessionClient;
    force?: boolean;
  },
): { acquired: boolean; holder: SessionLease | null } {
  try {
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  } catch {
    /* caller will surface the write failure */
  }

  const locked = acquireMutex(sessionDir);
  if (!locked) {
    // Never mutate ownership without the mutex: two clients could both decide
    // they acquired it. Report the current holder instead.
    return { acquired: false, holder: readLease(sessionDir) };
  }

  try {
    const existing = readLease(sessionDir);
    if (
      existing &&
      !options.force &&
      existing.pid !== process.pid &&
      isLeaseLive(existing)
    ) {
      return { acquired: false, holder: existing };
    }

    const now = Date.now();
    const procStart = processStartTime(process.pid);
    const lease: SessionLease = {
      sessionId: options.sessionId,
      pid: process.pid,
      host: hostname(),
      client: options.client ?? 'unknown',
      startedAt: existing?.pid === process.pid ? existing.startedAt : now,
      heartbeatAt: now,
      ...(procStart !== null ? { procStart } : {}),
    };

    // Owner process died while holding a lease left for a previous run: take it
    // over rather than waiting for the heartbeat to age out.
    try {
      writeFileSync(leasePath(sessionDir), JSON.stringify(lease), { mode: 0o600 });
    } catch {
      return { acquired: false, holder: existing };
    }
    return { acquired: true, holder: lease };
  } finally {
    releaseMutex(sessionDir);
  }
}

/**
 * Refresh the heartbeat, or (re)acquire when the lease is missing.
 * Returns false when the session directory is gone — the conversation was
 * deleted, and a heartbeat must never resurrect it.
 */
export function renewLeaseSync(
  sessionDir: string,
  sessionId: string,
  client: SessionClient = 'unknown',
): boolean {
  // acquireLeaseSync creates the session directory, so a heartbeat racing a
  // delete would rebuild it as an empty shell holding only .lease.json.
  if (!existsSync(sessionDir)) return false;
  const existing = readLease(sessionDir);
  if (!existing || existing.pid !== process.pid || existing.sessionId !== sessionId) {
    acquireLeaseSync(sessionDir, { sessionId, client });
    return true;
  }
  try {
    writeFileSync(
      leasePath(sessionDir),
      JSON.stringify({ ...existing, heartbeatAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
  return true;
}

/** Drop the lease if this process owns it. */
export function releaseLeaseSync(sessionDir: string, sessionId?: string): void {
  const existing = readLease(sessionDir);
  if (!existing || existing.pid !== process.pid) return;
  if (sessionId && existing.sessionId !== sessionId) return;
  try {
    unlinkSync(leasePath(sessionDir));
  } catch {
    /* best-effort */
  }
}

/**
 * Drop every lease this process holds under `sessionsRoot`.
 *
 * The desktop app creates one SessionManager per open conversation, each with
 * its own heartbeat, so releasing per manager would miss the others. Call this
 * once on shutdown: a lease left on disk is what makes the next launch treat a
 * finished conversation as "in use by another client" and fork a copy.
 */
export function releaseAllProcessLeases(sessionsRoot: string): number {
  let released = 0;
  let entries: string[];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const dir = join(sessionsRoot, name);
    const existing = readLease(dir);
    if (!existing || existing.pid !== process.pid) continue;
    try {
      unlinkSync(leasePath(dir));
      released++;
    } catch {
      /* best-effort */
    }
  }
  return released;
}

/**
 * Keep a held lease fresh until the returned stop function is called.
 * The timer is unref'd so it never keeps a CLI process alive. It stops itself
 * when the session directory disappears (the conversation was deleted).
 */
export function startLeaseHeartbeat(
  sessionDir: string,
  sessionId: string,
  client: SessionClient = 'unknown',
): () => void {
  const timer = setInterval(() => {
    if (!renewLeaseSync(sessionDir, sessionId, client)) {
      clearInterval(timer);
    }
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
