import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// SESSIONS_DIR is resolved at module load, so point it at a temp dir first.
const root = mkdtempSync(join(tmpdir(), 'coderix-cost-'));
process.env.CODERIX_SESSIONS_DIR = root;

let SessionManager: typeof import('../session.js').SessionManager;
let readSessionMeta: typeof import('../session-store.js').readSessionMeta;
let writeSessionMeta: typeof import('../session-store.js').writeSessionMeta;
let sessionDir: typeof import('../session-store.js').sessionDir;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
  ({ readSessionMeta, writeSessionMeta, sessionDir } = await import('../session-store.js'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** meta.json writes are queued and fire-and-forget; let the queue drain. */
const flushMeta = () => new Promise((resolve) => setTimeout(resolve, 80));

describe('session cost persistence', () => {
  it('writes the running total on every addCost without an explicit save', async () => {
    const manager = new SessionManager();
    const session = manager.create({ title: 'cost', currency: 'CNY' });
    manager.addMessage({ role: 'user', content: 'hi' });

    manager.addCost(0.25);
    await flushMeta();
    expect(readSessionMeta(sessionDir(session.id))?.totalCost).toBe(0.25);

    manager.addCost(0.5);
    await flushMeta();
    expect(readSessionMeta(sessionDir(session.id))?.totalCost).toBe(0.75);

    // A fresh manager reads the saved amount back.
    const reopened = new SessionManager();
    expect(reopened.get(session.id)?.totalCost).toBe(0.75);
  });

  it('ignores negative and non-finite costs', async () => {
    const manager = new SessionManager();
    const session = manager.create({ title: 'guard' });
    manager.addMessage({ role: 'user', content: 'hi' });
    manager.addCost(0.4);
    manager.addCost(-0.9);
    manager.addCost(Number.NaN);
    manager.addCost(Number.POSITIVE_INFINITY);
    await flushMeta();

    expect(manager.get(session.id)?.totalCost).toBe(0.4);
    expect(readSessionMeta(sessionDir(session.id))?.totalCost).toBe(0.4);
  });

  it('persists token usage alongside the cost', async () => {
    const manager = new SessionManager();
    const session = manager.create({ title: 'usage' });
    manager.addMessage({ role: 'user', content: 'hi' });
    manager.updateUsage({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadInputTokens: 480,
    });
    await flushMeta();

    const meta = readSessionMeta(sessionDir(session.id));
    expect(meta?.tokenUsage?.totalTokens).toBe(630);
    expect(new SessionManager().get(session.id)?.tokenUsage.totalTokens).toBe(630);
  });

  it('loads a corrupted negative total as zero', async () => {
    const manager = new SessionManager();
    const session = manager.create({ title: 'legacy negative' });
    manager.addMessage({ role: 'user', content: 'hi' });
    await flushMeta();
    await writeSessionMeta(sessionDir(session.id), { totalCost: -1.7375598 });

    const reopened = new SessionManager();
    expect(reopened.get(session.id)?.totalCost).toBe(0);
  });

  it('reports the persisted cost in session summaries', async () => {
    const manager = new SessionManager();
    const session = manager.create({ title: 'summarised', currency: 'USD' });
    manager.addMessage({ role: 'user', content: 'hi' });
    manager.addCost(1.5);
    await flushMeta();

    const summary = manager.list().find((s) => s.id === session.id);
    expect(summary?.totalCost).toBe(1.5);
    expect(summary?.currency).toBe('USD');
  });
});
