import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Separate file (and therefore a separate module graph) so this suite can
// break the sessions root without affecting the visibility suite.
const root = mkdtempSync(join(tmpdir(), 'coderix-list-errors-'));
process.env.CODERIX_SESSIONS_DIR = root;

let SessionManager: typeof import('../session.js').SessionManager;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('session list robustness', () => {
  it('skips a broken session directory instead of failing the whole list', async () => {
    const manager = new SessionManager(false, 'unknown');
    const good = manager.create({ title: 'good', cwd: root });
    manager.addMessage(good.id, { role: 'user', content: 'hi' });
    manager.addMessage(good.id, { role: 'assistant', content: 'hello' });
    await manager.flush();

    // A directory whose "session.jsonl" is itself a directory: readTailMetadata
    // cannot read it, so the entry must be skipped rather than thrown.
    const brokenDir = join(root, 'broken-session');
    mkdirSync(join(brokenDir, 'session.jsonl'), { recursive: true });

    const list = manager.list();
    expect(list.map((s) => s.id)).toContain(good.id);
    expect(list.map((s) => s.id)).not.toContain('broken-session');
  });

  it('reports a missing sessions root as an empty list, not an error', () => {
    const manager = new SessionManager(false, 'unknown');
    rmSync(root, { recursive: true, force: true });

    expect(manager.list()).toEqual([]);
  });

  it('degrades to an empty list for best-effort callers when the root cannot be read', () => {
    // Recreate the root as a regular file: readdirSync fails with ENOTDIR.
    writeFileSync(root, 'not a directory');

    const manager = new SessionManager(false, 'unknown');
    expect(manager.list()).toEqual([]);
  });

  it('surfaces an unreadable root to strict callers instead of pretending it is empty', () => {
    const manager = new SessionManager(false, 'unknown');
    expect(() => manager.listSessions(undefined, { strict: true })).toThrow();
  });
});
