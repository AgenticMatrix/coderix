import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { SessionEntry, Message } from '../types.js';
import { appendEntrySync, readEntriesSync, readMessagePageSync, entriesToMessages } from '../session-store.js';

/**
 * The chat view loads a tail page and pages backwards on demand. These tests
 * pin the two properties that make that safe:
 *
 *   - walking the cursor backwards reconstructs the transcript exactly (no
 *     message is dropped or reordered, however the pages are cut), and
 *   - a page never begins mid-turn, so a tool call and its result stay in the
 *     same page unless the turn alone exceeds the byte budget.
 */
function tmpDir(): string {
  const dir = join(tmpdir(), `coderix-page-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function userTurn(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function toolCall(id: string): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'working' },
      { type: 'tool_use', id, name: 'bash', input: { command: 'ls' } },
    ],
  };
}

function toolResult(id: string, body = 'ok'): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: body }],
  };
}

function answer(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

/** Append a chain of `turns` turns, each: prompt → tool call → result → answer. */
function writeTurns(filePath: string, turns: number): Message[] {
  const messages: Message[] = [];
  let parentUuid: string | null = null;
  for (let i = 0; i < turns; i++) {
    const call = `call-${i}`;
    const batch: Message[] = [userTurn(`q${i}`), toolCall(call), toolResult(call, `r${i}`), answer(`a${i}`)];
    for (const message of batch) {
      const uuid = randomUUID();
      appendEntrySync(filePath, {
        type: message.role as 'user' | 'assistant',
        uuid,
        parentUuid,
        timestamp: i,
        message,
      } as SessionEntry);
      // The transcript reconstructs by walking this chain, so it has to be
      // linked exactly like the session manager links real entries.
      parentUuid = uuid;
      messages.push(message);
    }
  }
  return messages;
}

/** Walk every page from the tail and return the reconstruction. */
function readAllPages(
  filePath: string,
  limit: number,
  maxBytes?: number,
  useOffset = false,
): Message[] {
  const collected: Message[] = [];
  let cursor: string | undefined;
  let offset: number | undefined;
  for (let guard = 0; guard < 10_000; guard++) {
    const page = readMessagePageSync(filePath, cursor, limit, maxBytes, useOffset ? offset : undefined);
    collected.unshift(...page.messages);
    if (!page.hasMore || !page.oldestUuid) break;
    cursor = page.oldestUuid;
    offset = page.oldestOffset ?? undefined;
  }
  return collected;
}

describe('readMessagePageSync', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = tmpDir();
    filePath = join(dir, 'session.jsonl');
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty page for a missing or empty file', () => {
    expect(readMessagePageSync(filePath, undefined, 10)).toEqual({
      messages: [],
      uuids: [],
      oldestUuid: null,
      oldestOffset: null,
      hasMore: false,
    });
  });

  it('reconstructs the whole transcript across pages, in order', () => {
    const written = writeTurns(filePath, 40);
    for (const limit of [1, 3, 7, 40, 500]) {
      expect(readAllPages(filePath, limit)).toEqual(written);
    }
  });

  it('reconstructs identically when cursor offsets are used', () => {
    const written = writeTurns(filePath, 40);
    for (const limit of [1, 3, 7, 40]) {
      expect(readAllPages(filePath, limit, undefined, true)).toEqual(written);
    }
  });

  it('reports a byte offset the next page can seek to', () => {
    writeTurns(filePath, 20);
    const tail = readMessagePageSync(filePath, undefined, 10);
    expect(typeof tail.oldestOffset).toBe('number');
    expect(tail.oldestOffset!).toBeGreaterThan(0);
    // Seeking to that offset yields the page that precedes the cursor.
    const older = readMessagePageSync(filePath, tail.oldestUuid ?? undefined, 10, undefined, tail.oldestOffset!);
    expect(older.messages.length).toBeGreaterThan(0);
    expect(older.uuids).not.toContain(tail.oldestUuid);
  });

  it('ignores a stale offset and still pages correctly', () => {
    // A rewritten/compacted transcript moves every byte offset. A stale hint
    // must not corrupt the page — paging falls back to locating the uuid.
    writeTurns(filePath, 20);
    const tail = readMessagePageSync(filePath, undefined, 10);
    const viaOffset = readMessagePageSync(
      filePath,
      tail.oldestUuid ?? undefined,
      10,
      undefined,
      tail.oldestOffset!,
    );
    const viaScan = readMessagePageSync(filePath, tail.oldestUuid ?? undefined, 10);
    expect(viaOffset.messages).toEqual(viaScan.messages);

    // An offset that lands mid-line must not crash or misparse.
    const bogus = readMessagePageSync(filePath, tail.oldestUuid ?? undefined, 10, undefined, 7);
    expect(bogus.messages).toEqual(viaScan.messages);
  });

  it('sees exactly the messages a whole-file read produces', () => {
    writeTurns(filePath, 25);
    const whole = entriesToMessages(readEntriesSync(filePath));
    expect(readAllPages(filePath, 4)).toEqual(whole);
  });

  it('never starts a page on a bare tool result', () => {
    writeTurns(filePath, 12);
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = readMessagePageSync(filePath, cursor, 4);
      const first = page.messages[0] as { role: string; content: unknown };
      const content = first.content;
      const isToolCarrier = Array.isArray(content)
        && content.length > 0
        && (content as Array<{ type: string }>).every((b) => b.type === 'tool_result');
      expect(isToolCarrier).toBe(false);
      if (!page.hasMore || !page.oldestUuid) break;
      cursor = page.oldestUuid;
    }
  });

  it('bounds a page by bytes even inside one oversized turn', () => {
    // One turn carrying a multi-megabyte tool result.
    const big = 'x'.repeat(4 * 1024 * 1024);
    let parentUuid: string | null = null;
    const push = (type: 'user' | 'assistant', message: Message): void => {
      const uuid = randomUUID();
      appendEntrySync(filePath, { type, uuid, parentUuid, timestamp: 0, message } as SessionEntry);
      parentUuid = uuid;
    };
    push('user', userTurn('render it'));
    push('assistant', toolCall('big-1'));
    push('user', toolResult('big-1', big));

    const page = readMessagePageSync(filePath, undefined, 60, 2 * 1024 * 1024);
    // The page keeps the call/result pair together — splitting them would leave
    // a tool card with a result it cannot attach — but does not drag the rest
    // of the oversized turn (the prompt) in with it.
    expect(page.messages).toHaveLength(2);
    expect(page.messages[0]).toMatchObject({ role: 'assistant' });
    expect(page.messages[1]).toMatchObject({ role: 'user' });
    expect(page.hasMore).toBe(true);
    // Nothing was lost: walking the cursor still yields all three messages.
    expect(readAllPages(filePath, 60, 2 * 1024 * 1024)).toHaveLength(3);
  });

  it('keeps uuids parallel to messages for stable renderer keys', () => {
    writeTurns(filePath, 6);
    const page = readMessagePageSync(filePath, undefined, 8);
    expect(page.uuids).toHaveLength(page.messages.length);
    expect(page.oldestUuid).toBe(page.uuids[0]);
  });

  it('does not return the cursor message itself (exclusive paging)', () => {
    writeTurns(filePath, 6);
    const first = readMessagePageSync(filePath, undefined, 4);
    const second = readMessagePageSync(filePath, first.oldestUuid ?? undefined, 4);
    const secondUuids = new Set(second.uuids);
    // Every uuid in page 1 is newer than the cursor, so none repeat in page 2.
    for (const uuid of first.uuids) expect(secondUuids.has(uuid)).toBe(false);
  });

  it('keeps a tool call and its result in one page when a synthetic message sits between them', () => {
    // A background-task notification is injected between the call and its
    // result. Turn alignment snaps the page to that notification, which would
    // otherwise leave the result on a page whose earlier page holds the call —
    // and the renderer, folding results into cards one page at a time, would
    // show a result with no card.
    let parentUuid: string | null = null;
    const push = (type: 'user' | 'assistant', message: Message): void => {
      const uuid = randomUUID();
      appendEntrySync(filePath, { type, uuid, parentUuid, timestamp: 0, message } as SessionEntry);
      parentUuid = uuid;
    };
    push('user', userTurn('run the long job'));
    push('assistant', toolCall('call-x'));
    push('user', userTurn('<background-agent-notifications>task finished</background-agent-notifications>'));
    push('user', toolResult('call-x', 'done'));
    push('assistant', answer('finished'));

    // Every page must contain both the call and its result, for any limit.
    for (const limit of [1, 2, 3]) {
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = readMessagePageSync(filePath, cursor, limit);
        const callIds = new Set<string>();
        const resultIds: string[] = [];
        for (const m of page.messages) {
          if (!Array.isArray(m.content)) continue;
          for (const b of m.content) {
            if (b.type === 'tool_use') callIds.add(b.id ?? '');
            if (b.type === 'tool_result') resultIds.push(b.tool_use_id ?? '');
          }
        }
        const orphaned = resultIds.filter((r) => !callIds.has(r));
        expect(orphaned, `limit=${limit}`).toEqual([]);
        if (!page.hasMore || !page.oldestUuid) break;
        cursor = page.oldestUuid;
      }
    }
  });
});