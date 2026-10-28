import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The store resolves its root from homedir() at import time, so point HOME at a
// temp dir before loading it.
const home = mkdtempSync(join(tmpdir(), 'coderix-meta-write-'));
const previousHome = process.env.HOME;
process.env.HOME = home;

const { sessionDir, sessionMetaPath, readSessionMeta, writeSessionMeta } = await import(
  '../session-store.js'
);

afterAll(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

/** Create a session dir and return its path. */
function freshDir(name: string): string {
  const dir = sessionDir(`00000000-0000-4000-8000-${name.padStart(12, '0')}`);
  return dir;
}

describe('meta.json writes', () => {
  it('keeps fields written by concurrent partial writers', async () => {
    const dir = freshDir('concurrent');
    await Promise.all([
      writeSessionMeta(dir, { title: 'concurrent title' }),
      writeSessionMeta(dir, { workDir: '/tmp/some-project' }),
      writeSessionMeta(dir, { contextTokens: 12_345 }),
    ]);

    const meta = readSessionMeta(dir);
    expect(meta?.title).toBe('concurrent title');
    expect(meta?.workDir).toBe('/tmp/some-project');
    expect(meta?.contextTokens).toBe(12_345);
  });

  it('leaves no temp file behind', async () => {
    const dir = freshDir('tempfiles');
    await writeSessionMeta(dir, { title: 'x' });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('refuses a partial write over an unreadable meta instead of dropping fields', async () => {
    const dir = freshDir('corrupt-partial');
    await writeSessionMeta(dir, { title: 'keep me', workDir: '/tmp/project' });

    // Simulate the legacy failure mode: two writers splicing full documents.
    const metaPath = sessionMetaPath(dir);
    const original = readFileSync(metaPath, 'utf-8');
    writeFileSync(metaPath, `${original}{"contextTokens": 42}\n`, 'utf-8');

    await writeSessionMeta(dir, { contextLength: 999 });

    // The damaged file is left alone — no patch-only rewrite that would lose
    // workDir/title, and no half-written replacement.
    expect(readFileSync(metaPath, 'utf-8')).toContain('"workDir": "/tmp/project"');
    expect(readSessionMeta(dir)).toBeNull();
  });

  it('rebuilds an unreadable meta from a full session snapshot', async () => {
    const dir = freshDir('corrupt-full');
    await writeSessionMeta(dir, { title: 'old', workDir: '/tmp/old-project' });
    const metaPath = sessionMetaPath(dir);
    const damaged = `${readFileSync(metaPath, 'utf-8')}garbage`;
    writeFileSync(metaPath, damaged, 'utf-8');

    await writeSessionMeta(dir, {
      title: 'rebuilt',
      workDir: '/tmp/new-project',
      model: 'test-model',
    });

    const meta = readSessionMeta(dir);
    expect(meta?.title).toBe('rebuilt');
    expect(meta?.workDir).toBe('/tmp/new-project');
    expect(meta?.model).toBe('test-model');

    // The damaged bytes are kept so the conversation's real workspace can still
    // be recovered from them (they may not match the rebuilt snapshot).
    expect(readFileSync(`${metaPath}.corrupt`, 'utf-8')).toBe(damaged);
  });

  it('does not resurrect a deleted session directory', async () => {
    const dir = freshDir('deleted');
    rmSync(dir, { recursive: true, force: true });
    const { writeSessionMetaExisting } = await import('../session-store.js');
    await writeSessionMetaExisting(dir, { title: 'late' });
    expect(readSessionMeta(dir)).toBeNull();
  });
});
