import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';

// SESSIONS_DIR is resolved at module load, so point it at a temp dir first.
const root = mkdtempSync(join(tmpdir(), 'coderix-lease-'));
process.env.CODERIX_SESSIONS_DIR = root;

let SessionManager: typeof import('../session.js').SessionManager;
let acquireLeaseSync: typeof import('../session-lease.js').acquireLeaseSync;
let inspectLease: typeof import('../session-lease.js').inspectLease;
let releaseLeaseSync: typeof import('../session-lease.js').releaseLeaseSync;
let releaseAllProcessLeases: typeof import('../session-lease.js').releaseAllProcessLeases;
let processStartTime: typeof import('../session-lease.js').processStartTime;
let leasePath: typeof import('../session-lease.js').leasePath;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
  ({
    acquireLeaseSync,
    inspectLease,
    releaseLeaseSync,
    releaseAllProcessLeases,
    processStartTime,
    leasePath,
  } = await import('../session-lease.js'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let sessionDir: string;

beforeEach(() => {
  sessionDir = join(root, `case-${Math.random().toString(36).slice(2)}`);
  mkdirSync(sessionDir, { recursive: true });
});

function writeLeaseAt(
  dir: string,
  pid: number,
  overrides: Record<string, unknown> = {},
): void {
  writeFileSync(
    leasePath(dir),
    JSON.stringify({
      sessionId: 's1',
      pid,
      host: hostname(),
      client: 'desktop',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      ...overrides,
    }),
  );
}

/** A pid that is guaranteed not to be running. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0']);
  return child.pid ?? 999_999_999;
}

describe('session lease', () => {
  it('is re-entrant for the same process', () => {
    expect(acquireLeaseSync(sessionDir, { sessionId: 's1', client: 'cli' }).acquired).toBe(true);
    expect(inspectLease(sessionDir).sameProcess).toBe(true);
    expect(acquireLeaseSync(sessionDir, { sessionId: 's1', client: 'cli' }).acquired).toBe(true);
  });

  it('blocks another live process', () => {
    // The test runner's parent process is alive and is not this process.
    writeLeaseAt(sessionDir, process.ppid);

    const inspection = inspectLease(sessionDir);
    expect(inspection.busy).toBe(true);
    expect(inspection.sameProcess).toBe(false);
    expect(acquireLeaseSync(sessionDir, { sessionId: 's1', client: 'cli' }).acquired).toBe(false);
  });

  it('takes over a lease left behind by a dead process', () => {
    writeLeaseAt(sessionDir, deadPid());

    expect(inspectLease(sessionDir).busy).toBe(false);
    expect(acquireLeaseSync(sessionDir, { sessionId: 's1', client: 'cli' }).acquired).toBe(true);
  });

  it('expires a foreign-host lease once its heartbeat is stale', () => {
    writeLeaseAt(sessionDir, process.ppid, {
      host: 'another-machine',
      heartbeatAt: Date.now() - 10 * 60_000,
    });

    expect(inspectLease(sessionDir).busy).toBe(false);
    expect(acquireLeaseSync(sessionDir, { sessionId: 's1', client: 'cli' }).acquired).toBe(true);
  });

  it('release only clears a lease owned by this process', () => {
    writeLeaseAt(sessionDir, process.ppid);
    releaseLeaseSync(sessionDir, 's1');
    expect(inspectLease(sessionDir).busy).toBe(true);

    acquireLeaseSync(sessionDir, { sessionId: 's1', client: 'cli', force: true });
    releaseLeaseSync(sessionDir, 's1');
    expect(inspectLease(sessionDir).holder).toBeNull();
  });

  it('treats a foreign-owned pid as dead instead of busy', () => {
    // A pid that exists but belongs to another user. Coderix only ever runs as
    // the current user, so EPERM means the lease's writer died and the pid was
    // recycled — the case that locked sessions forever after a reboot.
    const foreign = 1; // launchd/init, owned by root
    let errno: string | undefined;
    try {
      process.kill(foreign, 0);
    } catch (err) {
      errno = (err as NodeJS.ErrnoException).code;
    }
    if (errno !== 'EPERM') return; // running as root — nothing to assert

    writeLeaseAt(sessionDir, foreign);
    expect(inspectLease(sessionDir).busy).toBe(false);
    expect(acquireLeaseSync(sessionDir, { sessionId: 's1', client: 'cli' }).acquired).toBe(true);
  });

  it('treats a live pid with a different start time as recycled', () => {
    const actual = processStartTime(process.ppid);
    if (actual === null) return; // ps unavailable — cannot exercise this path

    // Same pid is alive, but it started a minute later than the lease says,
    // so it is a different process that inherited the pid.
    writeLeaseAt(sessionDir, process.ppid, { procStart: actual - 60_000 });
    expect(inspectLease(sessionDir).busy).toBe(false);

    // Within the tolerance it is the same process and must still block.
    writeLeaseAt(sessionDir, process.ppid, { procStart: actual });
    expect(inspectLease(sessionDir).busy).toBe(true);
  });

  it('does not resurrect a deleted session from a heartbeat', async () => {
    const { renewLeaseSync } = await import('../session-lease.js');
    const goneDir = join(root, 'deleted-session');
    mkdirSync(goneDir, { recursive: true });
    acquireLeaseSync(goneDir, { sessionId: 'gone', client: 'cli' });

    rmSync(goneDir, { recursive: true, force: true });
    expect(renewLeaseSync(goneDir, 'gone', 'cli')).toBe(false);
    // acquireLeaseSync would have recreated the directory; the heartbeat must not.
    expect(existsSync(goneDir)).toBe(false);
  });

  it('releases every lease this process holds, and none owned by others', () => {
    const mine = join(root, 'lease-own-1');
    const mineToo = join(root, 'lease-own-2');
    const foreign = join(root, 'lease-foreign');
    for (const dir of [mine, mineToo, foreign]) mkdirSync(dir, { recursive: true });

    acquireLeaseSync(mine, { sessionId: 'own-1', client: 'cli' });
    acquireLeaseSync(mineToo, { sessionId: 'own-2', client: 'cli' });
    writeLeaseAt(foreign, process.ppid);

    expect(releaseAllProcessLeases(root)).toBeGreaterThanOrEqual(2);
    expect(inspectLease(mine).holder).toBeNull();
    expect(inspectLease(mineToo).holder).toBeNull();
    expect(inspectLease(foreign).busy).toBe(true);
  });
});

describe('SessionManager lease handling', () => {
  it('refuses to resume a session another live client owns', async () => {
    const cli = new SessionManager(false, 'cli');
    const session = cli.create({ cwd: root });
    cli.addMessage(session.id, { role: 'user', content: 'hello' });
    await cli.flush();

    writeLeaseAt(join(root, session.id), process.ppid);

    const desktop = new SessionManager(false, 'desktop');
    expect(() => desktop.resume(session.id)).toThrowError(/in use by/);
  });

  it('copies the conversation when the session is busy instead of writing into it', async () => {
    const cli = new SessionManager(false, 'cli');
    const session = cli.create({ cwd: root });
    cli.addMessage(session.id, { role: 'user', content: 'first question' });
    cli.addMessage(session.id, { role: 'assistant', content: 'first answer' });
    await cli.flush();

    writeLeaseAt(join(root, session.id), process.ppid);

    const desktop = new SessionManager(false, 'desktop');
    const { session: copy, forkedFrom } = desktop.resumeOrFork(session.id);

    expect(forkedFrom).toBe(session.id);
    expect(copy.id).not.toBe(session.id);
    expect(copy.messages.map((m) => m.content)).toEqual(['first question', 'first answer']);
    // The copy is writable and its lease belongs to this process.
    expect(inspectLease(join(root, copy.id)).busy).toBe(false);
    expect(inspectLease(join(root, copy.id)).sameProcess).toBe(true);
  });

  it('reports a foreign-owned session as busy in list()', async () => {
    const cli = new SessionManager(false, 'cli');
    const live = cli.create({ cwd: root });
    cli.addMessage(live.id, { role: 'user', content: 'cli is chatting' });
    await cli.flush();

    writeLeaseAt(join(root, live.id), process.ppid);

    const summary = cli.list().find((s) => s.id === live.id);
    expect(summary?.busy).toBe(true);
  });
});
