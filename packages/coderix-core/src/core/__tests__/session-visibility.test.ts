import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// SESSIONS_DIR is resolved when the module loads, so point it at a temp dir
// before importing SessionManager (same pattern as session-lease.test.ts).
const root = mkdtempSync(join(tmpdir(), 'coderix-visibility-'));
process.env.CODERIX_SESSIONS_DIR = root;

let SessionManager: typeof import('../session.js').SessionManager;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('session visibility before the first disk write', () => {
  it('lists a freshly created session even though session.jsonl is absent', () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });

    expect(existsSync(join(root, session.id, 'session.jsonl'))).toBe(false);

    const entry = manager.list().find((s) => s.id === session.id);
    expect(entry).toBeDefined();
    expect(entry?.title).toBe('新对话');
    expect(entry?.workDir).toBe(root);
    expect(entry?.turnCount).toBe(0);
  });

  it('keeps the session listed when its workspace changes before the first message', () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });
    const newWorkspace = join(root, 'workspace-a');
    mkdirSync(newWorkspace, { recursive: true });

    // This is the "pick a newly created folder as workspace" path: setCwd is
    // the only disk write; no transcript exists yet.
    manager.setCwd(session.id, newWorkspace);

    const entry = manager.list().find((s) => s.id === session.id);
    expect(entry).toBeDefined();
    expect(entry?.workDir).toBe(newWorkspace);
  });

  it('serves the in-memory session through getSummary too', () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });

    const summary = manager.getSummary(session.id);
    expect(summary?.id).toBe(session.id);
    expect(summary?.title).toBe('新对话');
  });

  it('hands the session over to disk once the first turn is persisted', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });

    manager.addMessage(session.id, { role: 'user', content: '你好' });
    manager.addMessage(session.id, { role: 'assistant', content: '你好！' });
    await manager.flush();

    const live = manager.list().filter((s) => s.id === session.id);
    expect(live).toHaveLength(1);
    expect(live[0]?.title).toBe('你好');

    // A fresh manager only sees the disk, which now has the transcript.
    const restarted = new SessionManager(false, 'unknown');
    const afterRestart = restarted.list().find((s) => s.id === session.id);
    expect(afterRestart).toBeDefined();
    expect(afterRestart?.title).toBe('你好');
    expect(afterRestart?.workDir).toBe(root);
  });

  it('does not duplicate a session that exists both in memory and on disk', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });
    manager.addMessage(session.id, { role: 'user', content: '去重' });
    manager.addMessage(session.id, { role: 'assistant', content: '好的' });
    await manager.flush();

    expect(manager.list().filter((s) => s.id === session.id)).toHaveLength(1);
  });

  it('does not expose sub-agent child sessions as top-level entries', () => {
    const manager = new SessionManager(false, 'unknown');
    const parent = manager.create({ title: 'parent', cwd: root });
    const child = manager.create({
      title: 'child',
      cwd: root,
      parentSessionId: parent.id,
    });

    const ids = manager.list().map((s) => s.id);
    expect(ids).toContain(parent.id);
    expect(ids).not.toContain(child.id);
  });

  it('does not resurrect a never-persisted session after it is deleted', () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });

    // create() defers all writes, so there is no directory to remove.
    expect(existsSync(join(root, session.id))).toBe(false);
    expect(manager.list().some((s) => s.id === session.id)).toBe(true);

    manager.delete(session.id);

    expect(manager.list().some((s) => s.id === session.id)).toBe(false);
    expect(manager.getSummary(session.id)).toBeNull();
  });

  it('does not resurrect a persisted session deleted by another process', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '共享会话', cwd: root });
    manager.addMessage(session.id, { role: 'user', content: 'hello' });
    manager.addMessage(session.id, { role: 'assistant', content: 'hi' });
    await manager.flush();
    expect(manager.list().some((s) => s.id === session.id)).toBe(true);

    // Another client (or cleanup) removes the directory behind our back.
    rmSync(join(root, session.id), { recursive: true, force: true });

    expect(manager.list().some((s) => s.id === session.id)).toBe(false);
    expect(manager.getSummary(session.id)).toBeNull();
  });

  it('removes a persisted session from the list when deleted locally', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '待删除', cwd: root });
    manager.addMessage(session.id, { role: 'user', content: 'bye' });
    manager.addMessage(session.id, { role: 'assistant', content: 'bye' });
    await manager.flush();

    expect(manager.delete(session.id)).toBe(true);
    expect(manager.list().some((s) => s.id === session.id)).toBe(false);
  });
});
