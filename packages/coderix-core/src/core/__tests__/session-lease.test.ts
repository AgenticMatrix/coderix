import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
let leasePath: typeof import('../session-lease.js').leasePath;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
  ({ acquireLeaseSync, inspectLease, releaseLeaseSync, leasePath } = await import(
    '../session-lease.js'
  ));
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
