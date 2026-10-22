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
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isLeaseLive(lease: SessionLease): boolean {
  if (lease.host === hostname()) {
    // Same machine: pid liveness is authoritative. Heartbeats are skipped
    // while the host sleeps, so trusting them alone would yield false negatives.
    return isProcessAlive(lease.pid);
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
    const lease: SessionLease = {
      sessionId: options.sessionId,
      pid: process.pid,
      host: hostname(),
      client: options.client ?? 'unknown',
      startedAt: existing?.pid === process.pid ? existing.startedAt : now,
      heartbeatAt: now,
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

/** Refresh the heartbeat, or (re)acquire when the lease is missing. */
export function renewLeaseSync(
  sessionDir: string,
  sessionId: string,
  client: SessionClient = 'unknown',
): void {
  const existing = readLease(sessionDir);
  if (!existing || existing.pid !== process.pid || existing.sessionId !== sessionId) {
    acquireLeaseSync(sessionDir, { sessionId, client });
    return;
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
 * Keep a held lease fresh until the returned stop function is called.
 * The timer is unref'd so it never keeps a CLI process alive.
 */
export function startLeaseHeartbeat(
  sessionDir: string,
  sessionId: string,
  client: SessionClient = 'unknown',
): () => void {
  const timer = setInterval(() => {
    renewLeaseSync(sessionDir, sessionId, client);
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
