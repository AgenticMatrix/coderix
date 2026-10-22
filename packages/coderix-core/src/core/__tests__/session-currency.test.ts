import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// SESSIONS_DIR is resolved at module load, so point it at a temp dir first.
const root = mkdtempSync(join(tmpdir(), 'coderix-currency-'));
process.env.CODERIX_SESSIONS_DIR = root;

let SessionManager: typeof import('../session.js').SessionManager;
let readSessionMeta: typeof import('../session-store.js').readSessionMeta;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
  ({ readSessionMeta } = await import('../session-store.js'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** meta.json writes are queued and fire-and-forget; give the queue one turn. */
const flushMeta = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('session currency', () => {
  it('persists the currency through meta.json and resume', async () => {
    const manager = new SessionManager();
    const session = manager.create({ title: 'priced', currency: 'CNY' });
    manager.addMessage({ role: 'user', content: 'hello' });
    manager.addCost(1.25);
    manager.saveSession(manager.getActive());
    await flushMeta();

    const dir = join(root, session.id);
    const raw = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    expect(raw.currency).toBe('CNY');
    expect(raw.totalCost).toBe(1.25);
    expect(readSessionMeta(dir)?.currency).toBe('CNY');

    const resumed = new SessionManager();
    const loaded = resumed.resume(session.id);
    expect(loaded.currency).toBe('CNY');
    expect(loaded.totalCost).toBe(1.25);
  });

  it('updates the persisted currency when the bound provider changes', async () => {
    const manager = new SessionManager();
    const session = manager.create({ title: 'switch', currency: 'USD' });
    manager.addMessage({ role: 'user', content: 'hello' });
    manager.setCurrency(session.id, 'CNY');
    await flushMeta();

    expect(manager.get(session.id)?.currency).toBe('CNY');
    expect(readSessionMeta(join(root, session.id))?.currency).toBe('CNY');
  });
});
