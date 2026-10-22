import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'coderix-concurrency-'));
process.env.CODERIX_SESSIONS_DIR = root;

let SessionManager: typeof import('../session.js').SessionManager;
let sessionDir: typeof import('../session-store.js').sessionDir;
let sessionJsonlPath: typeof import('../session-store.js').sessionJsonlPath;
let readEntriesSync: typeof import('../session-store.js').readEntriesSync;
let appendEntrySync: typeof import('../session-store.js').appendEntrySync;
let entriesToMessages: typeof import('../session-store.js').entriesToMessages;
let isTranscriptEntry: typeof import('../types.js').isTranscriptEntry;
let randomUUID: typeof import('node:crypto').randomUUID;

beforeAll(async () => {
  ({ SessionManager } = await import('../session.js'));
  ({ sessionDir, sessionJsonlPath, readEntriesSync, appendEntrySync, entriesToMessages } =
    await import('../session-store.js'));
  ({ isTranscriptEntry } = await import('../types.js'));
  ({ randomUUID } = await import('node:crypto'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function transcriptLeaves(filePath: string) {
  const entries = readEntriesSync(filePath).filter(isTranscriptEntry);
  const hasChild = new Set(entries.filter((e) => e.parentUuid).map((e) => e.parentUuid));
  return entries.filter((e) => !hasChild.has(e.uuid));
}

describe('concurrent transcript writes', () => {
  it('keeps one linear chain when two managers append interleaved', async () => {
    const a = new SessionManager(false, 'cli');
    const session = a.create({ cwd: root });
    a.addMessage(session.id, { role: 'user', content: 'root' });
    await a.flush();

    // A second SessionManager stands in for the desktop process.
    const b = new SessionManager(false, 'desktop');
    b.resume(session.id);

    for (let i = 0; i < 5; i++) {
      a.addMessage(session.id, {
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: `a-${i}`,
      });
      b.addMessage(session.id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `b-${i}`,
      });
    }
    await Promise.all([a.flush(), b.flush()]);

    const filePath = sessionJsonlPath(sessionDir(session.id));
    const entries = readEntriesSync(filePath);
    const transcript = entries.filter(isTranscriptEntry);

    expect(transcript).toHaveLength(11);
    expect(transcriptLeaves(filePath)).toHaveLength(1);

    const messages = entriesToMessages(entries);
    expect(messages).toHaveLength(11);
    for (const content of ['root', 'a-0', 'b-0', 'a-4', 'b-4']) {
      expect(messages.filter((m) => m.content === content)).toHaveLength(1);
    }
  });

  it('preserves entries another manager appended when compacting', async () => {
    const a = new SessionManager(false, 'cli');
    const session = a.create({ cwd: root });
    a.addMessage(session.id, { role: 'user', content: 'keep-1' });
    a.addMessage(session.id, { role: 'assistant', content: 'keep-2' });
    await a.flush();

    const b = new SessionManager(false, 'desktop');
    b.resume(session.id);

    a.addMessage(session.id, { role: 'user', content: 'dropped-by-compaction' });
    b.addMessage(session.id, { role: 'user', content: 'external-turn' });
    await Promise.all([a.flush(), b.flush()]);

    // Compact down to the first two messages.
    a.replaceMessages(session.id, [
      { role: 'user', content: 'keep-1' },
      { role: 'assistant', content: 'keep-2' },
    ]);
    await a.flush();

    const filePath = sessionJsonlPath(sessionDir(session.id));
    const messages = entriesToMessages(readEntriesSync(filePath));
    const contents = messages.map((m) => m.content);

    expect(contents).toContain('external-turn');
    expect(contents).not.toContain('dropped-by-compaction');
    expect(transcriptLeaves(filePath)).toHaveLength(1);
  });

  it('recovers messages from a transcript that already forked', () => {
    const dir = join(root, `forked-${randomUUID()}`);
    const filePath = join(dir, 'session.jsonl');

    const ts = 1_000;
    const make = (
      type: 'user' | 'assistant',
      uuid: string,
      parentUuid: string | null,
      content: string,
      timestamp: number,
    ) => ({
      type,
      uuid,
      parentUuid,
      timestamp,
      message: { role: type, content },
    });

    appendEntrySync(filePath, make('user', 'u1', null, 'root', ts) as never);
    appendEntrySync(filePath, make('assistant', 'u2', 'u1', 'shared', ts + 10) as never);
    // Two writers both chained from u2.
    appendEntrySync(filePath, make('user', 'u3a', 'u2', 'branch-A', ts + 20) as never);
    appendEntrySync(filePath, make('user', 'u3b', 'u2', 'branch-B', ts + 30) as never);
    appendEntrySync(filePath, make('assistant', 'u4b', 'u3b', 'branch-B-2', ts + 40) as never);

    const contents = entriesToMessages(readEntriesSync(filePath)).map((m) => m.content);
    // The longest chain stays in its original order; the orphaned branch is
    // appended after it rather than re-sorted into the main line.
    expect(contents).toEqual(['root', 'shared', 'branch-B', 'branch-B-2', 'branch-A']);
  });

  it('never moves a tool_result ahead of the tool_use it belongs to', () => {
    const dir = join(root, `toolpair-${randomUUID()}`);
    const filePath = join(dir, 'session.jsonl');

    const make = (
      type: 'user' | 'assistant',
      uuid: string,
      parentUuid: string | null,
      content: string,
      timestamp: number,
    ) => ({ type, uuid, parentUuid, timestamp, message: { role: type, content } });

    appendEntrySync(filePath, make('user', 't1', null, 'root', 10) as never);
    // The orphan line landed before its parent in the file (older append race).
    appendEntrySync(filePath, make('user', 't2b', 't2', 'other-branch', 20) as never);
    appendEntrySync(filePath, make('assistant', 't2', 't1', 'tool-use', 20) as never);
    appendEntrySync(filePath, make('user', 't3', 't2', 'tool-result', 30) as never);

    const contents = entriesToMessages(readEntriesSync(filePath)).map((m) => m.content);
    expect(contents).toEqual(['root', 'tool-use', 'tool-result', 'other-branch']);
  });
});

describe('cleanup safety', () => {
  it('keeps a freshly written session that has no assistant reply yet', async () => {
    const a = new SessionManager(false, 'cli');
    const session = a.create({ cwd: root });
    a.addMessage(session.id, { role: 'user', content: 'still thinking' });
    await a.flush();

    expect(a.cleanupIncompleteSessions()).toBe(0);
    expect(existsSync(sessionJsonlPath(sessionDir(session.id)))).toBe(true);
  });

  it('still removes a genuinely stale session with no assistant reply', async () => {
    const a = new SessionManager(false, 'cli');
    const session = a.create({ cwd: root });
    a.addMessage(session.id, { role: 'user', content: 'abandoned' });
    await a.flush();

    const filePath = sessionJsonlPath(sessionDir(session.id));
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(filePath, old, old);

    expect(a.cleanupIncompleteSessions()).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });
});
