import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The session manager resolves its storage root from homedir() at import time,
// so point HOME at a temp dir before loading it.
const home = mkdtempSync(join(tmpdir(), 'coderix-reload-usage-'));
const previousHome = process.env.HOME;
process.env.HOME = home;

const { SessionManager } = await import('../session.js');
const { sessionDir, writeSessionMeta } = await import('../session-store.js');

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
};

afterAll(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('SessionManager.reload token usage', () => {
  it('keeps live buckets when the disk snapshot is all zeros', async () => {
    const writer = new SessionManager(false, 'cli');
    const session = writer.create({ title: 'reload usage', model: 'test-model' });
    writer.addMessage(session.id, { role: 'user', content: 'hi' });
    writer.addMessage(session.id, { role: 'assistant', content: 'hello' });
    writer.updateUsage(session.id, {
      inputTokens: 120,
      outputTokens: 30,
      cacheReadInputTokens: 480,
    });
    writer.saveSession(session);
    await writer.flush();

    // A second client opens the session and accumulates its own live totals.
    const reader = new SessionManager(false, 'desktop');
    const opened = reader.reload(session.id);
    expect(opened?.tokenUsage.cacheReadInputTokens).toBe(480);
    reader.updateUsage(session.id, {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 1000,
    });

    // Another turn lands on disk, then a stale zero snapshot overwrites meta.
    writer.addMessage(session.id, { role: 'user', content: 'another turn' });
    await writer.flush();
    await writeSessionMeta(sessionDir(session.id), {
      title: session.title,
      workDir: session.cwd,
      model: session.model,
      totalCost: 0,
      tokenUsage: ZERO_USAGE,
    });

    const reloaded = reader.reload(session.id);
    // 120 + 10 input, 30 + 5 output, 480 + 1000 cache read — the zero snapshot
    // must not erase what this client already had in memory.
    expect(reloaded?.tokenUsage.inputTokens).toBe(130);
    expect(reloaded?.tokenUsage.outputTokens).toBe(35);
    expect(reloaded?.tokenUsage.cacheReadInputTokens).toBe(1480);
    expect(reloaded?.tokenUsage.totalTokens).toBe(1645);
  });

  it('takes larger disk totals so another client is never undercounted', async () => {
    const writer = new SessionManager(false, 'cli');
    const session = writer.create({ title: 'disk wins', model: 'test-model' });
    writer.addMessage(session.id, { role: 'user', content: 'hi' });
    writer.updateUsage(session.id, {
      inputTokens: 900,
      outputTokens: 100,
      cacheReadInputTokens: 4000,
    });
    writer.saveSession(session);
    await writer.flush();

    const reader = new SessionManager(false, 'desktop');
    reader.reload(session.id);
    reader.updateUsage(session.id, { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 });

    // Another client does more work and writes a larger cumulative snapshot.
    writer.updateUsage(session.id, {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 500,
    });
    writer.addMessage(session.id, { role: 'user', content: 'more' });
    await writer.flush();
    // meta writes are fire-and-forget; write the snapshot deterministically.
    await writeSessionMeta(sessionDir(session.id), {
      title: session.title,
      workDir: session.cwd,
      model: session.model,
      totalCost: writer.get(session.id)!.totalCost,
      tokenUsage: writer.get(session.id)!.tokenUsage,
    });

    const reloaded = reader.reload(session.id);
    expect(reloaded?.tokenUsage.inputTokens).toBe(1000);
    expect(reloaded?.tokenUsage.cacheReadInputTokens).toBe(4500);
  });
});
