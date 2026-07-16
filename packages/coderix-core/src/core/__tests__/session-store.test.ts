import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SessionEntry, Message } from '../types.js';

// We import the functions directly — they use real fs but we point them at a tmp dir.
// The session-store uses homedir()/.coderix/sessions by default, so we test the
// low-level functions directly by passing absolute paths into a tmp dir.

import {
  appendEntry,
  appendEntrySync,
  readEntries,
  readEntriesSync,
  rewriteEntries,
  entriesToMessages,
  readTailMetadata,
  needsMigration,
  migrateLegacySession,
  sessionJsonlPath,
  subAgentJsonlPath,
  legacySessionJsonPath,
} from '../session-store.js';

function tmpDir(): string {
  const dir = join(tmpdir(), `coderix-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    timestamp: Date.now(),
    message: { role: 'user', content: 'hello' },
    ...overrides,
  } as SessionEntry;
}

describe('session-store', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  // ── appendEntry / readEntries round-trip ──────────────────────────

  describe('appendEntry / readEntries', () => {
    it('round-trips a single entry', async () => {
      const filePath = join(dir, 'session.jsonl');
      const entry = makeSessionEntry();

      await appendEntry(filePath, entry);
      const entries = await readEntries(filePath);

      expect(entries).toHaveLength(1);
      expect(entries[0]!.type).toBe('user');
      expect((entries[0]! as any).uuid).toBe((entry as any).uuid);
    });

    it('round-trips multiple entries in order', async () => {
      const filePath = join(dir, 'session.jsonl');
      const e1 = makeSessionEntry();
      const e2 = makeSessionEntry({ type: 'assistant' });
      const e3 = makeSessionEntry({ type: 'title' } as any);

      await appendEntry(filePath, e1);
      await appendEntry(filePath, e2);
      await appendEntry(filePath, e3);

      const entries = await readEntries(filePath);
      expect(entries).toHaveLength(3);
      expect(entries[0]!.type).toBe('user');
      expect(entries[1]!.type).toBe('assistant');
      expect(entries[2]!.type).toBe('title');
    });

    it('handles special characters and Unicode', async () => {
      const filePath = join(dir, 'session.jsonl');
      const entry = makeSessionEntry({
        message: { role: 'user', content: '你好世界\nline2\t"quoted" \\backslash' },
      });

      await appendEntry(filePath, entry);
      const entries = await readEntries(filePath);

      expect(entries).toHaveLength(1);
      const msg = entries[0] as any;
      expect(msg.message.content).toBe('你好世界\nline2\t"quoted" \\backslash');
    });

    it('skips corrupted lines', async () => {
      const filePath = join(dir, 'session.jsonl');
      const entry = makeSessionEntry();

      await appendEntry(filePath, entry);
      // Append a corrupted line
      writeFileSync(filePath, 'not valid json\n', { flag: 'a' });
      await appendEntry(filePath, makeSessionEntry({ type: 'assistant' }));

      const entries = await readEntries(filePath);
      // 2 valid entries, 1 corrupted line skipped
      expect(entries).toHaveLength(2);
    });

    it('sync versions work', () => {
      const filePath = join(dir, 'session.jsonl');
      const entry = makeSessionEntry();

      appendEntrySync(filePath, entry);
      const entries = readEntriesSync(filePath);

      expect(entries).toHaveLength(1);
    });
  });

  // ── rewriteEntries ───────────────────────────────────────────────

  describe('rewriteEntries', () => {
    it('atomically replaces all entries', async () => {
      const filePath = join(dir, 'session.jsonl');
      await appendEntry(filePath, makeSessionEntry());
      await appendEntry(filePath, makeSessionEntry({ type: 'assistant' }));

      const newEntries = [makeSessionEntry({ type: 'system' })];
      await rewriteEntries(filePath, newEntries);

      const entries = await readEntries(filePath);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.type).toBe('system');
    });

    it('does not leave .tmp file on success', async () => {
      const filePath = join(dir, 'session.jsonl');
      await appendEntry(filePath, makeSessionEntry());

      await rewriteEntries(filePath, [makeSessionEntry()]);

      expect(existsSync(filePath + '.tmp')).toBe(false);
    });
  });

  // ── entriesToMessages ─────────────────────────────────────────────

  describe('entriesToMessages', () => {
    it('reconstructs messages in parentUuid chain order', () => {
      const uuid1 = randomUUID();
      const uuid2 = randomUUID();
      const uuid3 = randomUUID();

      const entries: SessionEntry[] = [
        { type: 'user', uuid: uuid1, parentUuid: null, timestamp: 1, message: { role: 'user', content: 'q1' } } as SessionEntry,
        { type: 'assistant', uuid: uuid2, parentUuid: uuid1, timestamp: 2, message: { role: 'assistant', content: 'a1' } } as SessionEntry,
        { type: 'user', uuid: uuid3, parentUuid: uuid2, timestamp: 3, message: { role: 'user', content: 'q2' } } as SessionEntry,
        { type: 'title', title: 'Test' } as SessionEntry,
      ];

      const messages = entriesToMessages(entries);
      expect(messages).toHaveLength(3);
      expect(messages[0]!.role).toBe('user');
      expect(messages[1]!.role).toBe('assistant');
      expect(messages[2]!.role).toBe('user');
    });

    it('returns empty array for no transcript entries', () => {
      const entries: SessionEntry[] = [
        { type: 'title', title: 'Test' } as SessionEntry,
      ];
      expect(entriesToMessages(entries)).toHaveLength(0);
    });

    it('handles single entry', () => {
      const uuid = randomUUID();
      const entries: SessionEntry[] = [
        { type: 'user', uuid, parentUuid: null, timestamp: 1, message: { role: 'user', content: 'hi' } } as SessionEntry,
      ];
      const messages = entriesToMessages(entries);
      expect(messages).toHaveLength(1);
    });
  });

  // ── readTailMetadata ──────────────────────────────────────────────

  describe('readTailMetadata', () => {
    it('extracts last title from JSONL tail', async () => {
      const filePath = join(dir, 'session.jsonl');
      await appendEntry(filePath, { type: 'title', title: 'First' } as SessionEntry);
      await appendEntry(filePath, makeSessionEntry());
      await appendEntry(filePath, { type: 'title', title: 'Last' } as SessionEntry);

      const { lastTitle, entryCount } = readTailMetadata(filePath);
      expect(lastTitle).toBe('Last');
      expect(entryCount).toBe(3);
    });

    it('returns null title when no title entry exists', async () => {
      const filePath = join(dir, 'session.jsonl');
      await appendEntry(filePath, makeSessionEntry());

      const { lastTitle } = readTailMetadata(filePath);
      expect(lastTitle).toBeNull();
    });

    it('returns 0 entries for non-existent file', () => {
      const { lastTitle, entryCount } = readTailMetadata(join(dir, 'nonexistent.jsonl'));
      expect(lastTitle).toBeNull();
      expect(entryCount).toBe(0);
    });
  });

  // ── Path functions ────────────────────────────────────────────────

  describe('path functions', () => {
    it('sessionJsonlPath returns correct path', () => {
      const p = sessionJsonlPath(dir);
      expect(p).toBe(join(dir, 'session.jsonl'));
    });

    it('subAgentJsonlPath returns correct path', () => {
      const p = subAgentJsonlPath(dir, 'agent-123');
      expect(p).toBe(join(dir, 'subagents', 'agent-agent-123.jsonl'));
    });

    it('legacySessionJsonPath returns correct path', () => {
      const p = legacySessionJsonPath(dir);
      expect(p).toBe(join(dir, 'session.json'));
    });
  });

  // ── Migration ─────────────────────────────────────────────────────

  describe('migration', () => {
    it('needsMigration returns true when session.json exists without session.jsonl', () => {
      writeFileSync(join(dir, 'session.json'), JSON.stringify({
        id: 'test-1',
        title: 'Legacy',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
        turnCount: 1,
        totalCost: 0,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        metadata: {},
      }));

      expect(needsMigration(dir)).toBe(true);
    });

    it('needsMigration returns false when session.jsonl exists', async () => {
      await appendEntry(sessionJsonlPath(dir), makeSessionEntry());
      expect(needsMigration(dir)).toBe(false);
    });

    it('migrateLegacySession converts messages to JSONL', async () => {
      writeFileSync(join(dir, 'session.json'), JSON.stringify({
        id: 'test-2',
        title: 'Legacy Session',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        turnCount: 1,
        totalCost: 0,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        metadata: {},
      }));

      const result = await migrateLegacySession(dir);
      expect(result).toBe(true);

      // JSONL should exist
      const jsonlPath = sessionJsonlPath(dir);
      expect(existsSync(jsonlPath)).toBe(true);

      // Messages should be preserved
      const entries = await readEntries(jsonlPath);
      const messages = entriesToMessages(entries);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.role).toBe('user');
      expect(messages[1]!.role).toBe('assistant');

      // Old file should be backed up
      expect(existsSync(join(dir, 'session.json.bak'))).toBe(true);
      expect(existsSync(join(dir, 'session.json'))).toBe(false);
    });

    it('migrateLegacySession returns false when no legacy file', async () => {
      const result = await migrateLegacySession(dir);
      expect(result).toBe(false);
    });

    it('migrateLegacySession preserves title', async () => {
      writeFileSync(join(dir, 'session.json'), JSON.stringify({
        id: 'test-3',
        title: 'My Title',
        messages: [{ role: 'user', content: 'x' }],
        turnCount: 0,
        totalCost: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        metadata: {},
      }));

      await migrateLegacySession(dir);

      const entries = await readEntries(sessionJsonlPath(dir));
      const titleEntries = entries.filter((e) => e.type === 'title');
      expect(titleEntries).toHaveLength(1);
      expect((titleEntries[0] as any).title).toBe('My Title');
    });
  });
});
