import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// SESSIONS_DIR is resolved at module load, so point it at a temp dir first.
const root = mkdtempSync(join(tmpdir(), 'coderix-origin-'));
process.env.CODERIX_SESSIONS_DIR = root;

let SessionManager: typeof import('../session.js').SessionManager;
let readSessionMeta: typeof import('../session-store.js').readSessionMeta;
let sessionDir: typeof import('../session-store.js').sessionDir;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
  ({ readSessionMeta, sessionDir } = await import('../session-store.js'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('session origin', () => {
  it('stamps CLI origin on the first write and keeps it in summaries', async () => {
    const cli = new SessionManager(false, 'cli');
    const session = cli.create({ title: 'cli conversation', cwd: root });

    // Before the first append the session only exists in memory.
    expect(cli.list().find((s) => s.id === session.id)?.origin).toBe('cli');

    cli.addMessage(session.id, { role: 'user', content: 'hello from cli' });
    await cli.flush();

    expect(readSessionMeta(sessionDir(session.id))?.origin).toBe('cli');

    // A different client watching the shared sessions dir sees the same origin.
    const desktop = new SessionManager(false, 'desktop');
    const listed = desktop.list().find((s) => s.id === session.id);
    expect(listed?.origin).toBe('cli');
  });

  it('stamps desktop origin on the first write', async () => {
    const desktop = new SessionManager(false, 'desktop');
    const session = desktop.create({ title: 'desktop conversation', cwd: root });

    expect(desktop.list().find((s) => s.id === session.id)?.origin).toBe('desktop');

    desktop.addMessage(session.id, { role: 'user', content: 'hello from desktop' });
    await desktop.flush();

    expect(readSessionMeta(sessionDir(session.id))?.origin).toBe('desktop');
  });

  it('does not overwrite origin when another client resumes and appends', async () => {
    const cli = new SessionManager(false, 'cli');
    const session = cli.create({ title: 'cross-client conversation', cwd: root });
    cli.addMessage(session.id, { role: 'user', content: 'created by cli' });
    await cli.flush();

    const desktop = new SessionManager(false, 'desktop');
    desktop.resume(session.id);
    desktop.addMessage(session.id, { role: 'assistant', content: 'continued in desktop' });
    await desktop.flush();

    expect(readSessionMeta(sessionDir(session.id))?.origin).toBe('cli');
    expect(desktop.getSummary(session.id)?.origin).toBe('cli');
  });

  it('leaves origin absent for managers with an unknown client', async () => {
    const unknown = new SessionManager(false);
    const session = unknown.create({ title: 'unknown conversation', cwd: root });
    unknown.addMessage(session.id, { role: 'user', content: 'who am i' });
    await unknown.flush();

    expect(readSessionMeta(sessionDir(session.id))?.origin).toBeUndefined();
    expect(unknown.getSummary(session.id)?.origin).toBeUndefined();
  });
});

describe('session list origin filter', () => {
  it('keeps only the requested origins', async () => {
    const writer = new SessionManager(false, 'desktop');
    const desktopSession = writer.create({ title: 'desktop one', cwd: root });
    writer.addMessage(desktopSession.id, { role: 'user', content: 'desktop' });
    await writer.flush();

    const cli = new SessionManager(false, 'cli');
    const cliSession = cli.create({ title: 'cli one', cwd: root });
    cli.addMessage(cliSession.id, { role: 'user', content: 'cli' });
    await cli.flush();

    const listed = writer.list({ origin: ['desktop'], limit: 1000 });

    expect(listed.some((s) => s.id === desktopSession.id)).toBe(true);
    expect(listed.some((s) => s.id === cliSession.id)).toBe(false);
    expect(listed.every((s) => s.origin === 'desktop')).toBe(true);
  });

  it('never matches a session whose origin is unknown', async () => {
    const unknown = new SessionManager(false);
    const session = unknown.create({ title: 'legacy shaped', cwd: root });
    unknown.addMessage(session.id, { role: 'user', content: 'no origin' });
    await unknown.flush();

    const reader = new SessionManager(false, 'desktop');
    expect(reader.list({ origin: ['desktop'], limit: 1000 }).some((s) => s.id === session.id)).toBe(false);
    // ...nor to an explicitly requested 'unknown' client, which is not a real
    // creation client — those sessions predate the field entirely.
    expect(reader.list({ origin: ['unknown'], limit: 1000 }).some((s) => s.id === session.id)).toBe(false);
  });

  it('applies the limit after filtering, not before', async () => {
    // Three CLI conversations are newer than the desktop ones, so a
    // filter-after-slice implementation would return fewer than `limit` rows.
    const cli = new SessionManager(false, 'cli');
    for (let i = 0; i < 3; i++) {
      const s = cli.create({ title: `cli ${i}`, cwd: root });
      cli.addMessage(s.id, { role: 'user', content: `cli ${i}` });
    }
    await cli.flush();

    const writer = new SessionManager(false, 'desktop');
    for (let i = 0; i < 3; i++) {
      const s = writer.create({ title: `desktop ${i}`, cwd: root });
      writer.addMessage(s.id, { role: 'user', content: `desktop ${i}` });
    }
    await writer.flush();

    const listed = writer.list({ origin: ['desktop'], limit: 2 });
    expect(listed).toHaveLength(2);
    expect(listed.every((s) => s.origin === 'desktop')).toBe(true);
  });

  it('returns every session when no origin filter is given', async () => {
    const writer = new SessionManager(false, 'desktop');
    const desktopSession = writer.create({ title: 'd', cwd: root });
    writer.addMessage(desktopSession.id, { role: 'user', content: 'd' });
    await writer.flush();

    const cli = new SessionManager(false, 'cli');
    const cliSession = cli.create({ title: 'c', cwd: root });
    cli.addMessage(cliSession.id, { role: 'user', content: 'c' });
    await cli.flush();

    const ids = writer.list({ limit: 1000 }).map((s) => s.id);
    expect(ids).toContain(desktopSession.id);
    expect(ids).toContain(cliSession.id);
  });
});
