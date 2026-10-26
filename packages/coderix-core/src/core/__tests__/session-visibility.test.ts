import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// SESSIONS_DIR is resolved when the module loads, so point it at a temp dir
// before importing SessionManager (same pattern as session-lease.test.ts).
const root = mkdtempSync(join(tmpdir(), 'coderix-visibility-'));
process.env.CODERIX_SESSIONS_DIR = root;

let SessionManager: typeof import('../session.js').SessionManager;
let refineSessionTitle: typeof import('../session-store.js').refineSessionTitle;
let writeSessionMetaExisting: typeof import('../session-store.js').writeSessionMetaExisting;
let appendEntrySync: typeof import('../session-store.js').appendEntrySync;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
  ({ refineSessionTitle, writeSessionMetaExisting, appendEntrySync } = await import('../session-store.js'));
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
    expect(live[0]?.titleSource).toBe('fallback');

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

  it('persists a provider title and restores its source after restart', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });
    manager.addMessage(session.id, { role: 'user', content: '帮我看下登录问题' });
    manager.addMessage(session.id, { role: 'assistant', content: '好的' });
    await manager.flush();

    expect(manager.setSessionTitle(session.id, '登录鉴权排查', 'provider', 'p/m'))
      .toBe('登录鉴权排查');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const restarted = new SessionManager(false, 'unknown');
    const summary = restarted.list().find((s) => s.id === session.id);
    expect(summary?.title).toBe('登录鉴权排查');
    expect(summary?.titleSource).toBe('provider');
  });

  it('does not refine a title pinned by the user', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });
    manager.addMessage(session.id, { role: 'user', content: '帮我分析一下这个问题' });
    manager.addMessage(session.id, { role: 'assistant', content: '好' });
    await manager.flush();

    manager.setSessionTitle(session.id, '我的固定标题', 'user');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await refineSessionTitle(session.id, async () => '自动标题')).toBeNull();
  });

  it('refines a fallback title into a provider title on disk', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });
    manager.addMessage(session.id, { role: 'user', content: '帮我分析一下这个问题' });
    manager.addMessage(session.id, { role: 'assistant', content: '好' });
    await manager.flush();

    expect(await refineSessionTitle(session.id, async () => '自动标题')).toBe('自动标题');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const restarted = new SessionManager(false, 'unknown');
    const summary = restarted.list().find((s) => s.id === session.id);
    expect(summary?.title).toBe('自动标题');
    expect(summary?.titleSource).toBe('provider');
  });

  it('never overwrites a user-pinned title with the fallback', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: 'Blender Plugin', cwd: root });
    manager.addMessage(session.id, { role: 'user', content: '请帮我改一下这个模型' });
    await manager.flush();

    expect(session.title).toBe('Blender Plugin');
    expect(session.titleSource).toBe('user');
    expect(manager.applyFallbackTitle(session.id, '另一段完全不同的输入')).toBeNull();
    expect(session.title).toBe('Blender Plugin');
  });

  it('never derives a title from a compaction continuation message', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });
    const compactText = 'This session is being continued from a previous conversation that ran out of context.';

    manager.addMessage(session.id, { role: 'user', content: compactText });
    await manager.flush();
    expect(session.titleSource).toBe('default');
    expect(manager.applyFallbackTitle(session.id, compactText)).toBeNull();
    expect(session.title).toBe('新对话');
  });

  it('does not recreate a deleted directory for a background title write', async () => {
    const dir = join(root, 'deleted-session');
    mkdirSync(dir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });

    await writeSessionMetaExisting(dir, { title: 'Late title', titleSource: 'provider' });
    expect(existsSync(dir)).toBe(false);
  });

  it('prefers a provider meta title over a legacy JSONL title on resume', async () => {
    const manager = new SessionManager(false, 'unknown');
    const session = manager.create({ title: '新对话', cwd: root });
    manager.addMessage(session.id, { role: 'user', content: '帮我看下登录问题' });
    manager.addMessage(session.id, { role: 'assistant', content: '好' });
    await manager.flush();

    appendEntrySync(join(root, session.id, 'session.jsonl'), {
      type: 'title',
      title: '旧标题',
    } as never);
    manager.setSessionTitle(session.id, '登录鉴权排查', 'provider', 'p/m');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const restarted = new SessionManager(false, 'unknown');
    const resumed = restarted.resume(session.id);
    expect(resumed.title).toBe('登录鉴权排查');
    expect(resumed.titleSource).toBe('provider');
  });
});
