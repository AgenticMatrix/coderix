import { describe, it, expect } from 'vitest';

import {
  isMessageSettled,
  splitTranscript,
  shouldFlush,
  initialEpoch,
  advanceEpoch,
} from '../transcript-commit.js';
import type { Message, ContentBlock, ToolUseState } from '../../../types.js';

/**
 * The commit boundary decides which messages get written to the terminal's
 * scrollback permanently. A message committed too early strands a stale copy on
 * screen that no repaint can reach — so these tests are mostly about the
 * boundary being conservative in the ways that actually bite.
 */

let nextId = 0;
function msg(blocks: ContentBlock[] = [], overrides: Partial<Message> = {}): Message {
  nextId += 1;
  return {
    id: nextId,
    role: 'assistant',
    content: '',
    blocks,
    timestamp: 0,
    ...overrides,
  };
}

function tool(state: ToolUseState, toolId = 't1'): ContentBlock {
  return { type: 'tool_use', toolName: 'Bash', toolId, input: {}, state };
}

const text = (content = 'hi'): ContentBlock => ({ type: 'text', content });

describe('isMessageSettled', () => {
  it('treats text-only messages as settled', () => {
    expect(isMessageSettled(msg([text()]))).toBe(true);
  });

  it('treats a message with no blocks as settled', () => {
    expect(isMessageSettled(msg([]))).toBe(true);
  });

  it.each([
    ['pending', false],
    ['executing', false],
    ['done', true],
    ['error', true],
  ] as const)('tool_use in %s -> settled=%s', (state, expected) => {
    expect(isMessageSettled(msg([tool(state)]))).toBe(expected);
  });

  it('is unsettled if ANY block is still in flight', () => {
    // A message is committed whole, so one live block pins the entire message.
    expect(isMessageSettled(msg([text(), tool('done'), tool('executing', 't2')]))).toBe(false);
  });

  it('keeps a running sub-agent live', () => {
    const subagent: ContentBlock = {
      type: 'subagent',
      agentType: 'general-purpose',
      agentName: 'worker',
      agentId: 'a1',
      state: 'running',
    } as ContentBlock;
    expect(isMessageSettled(msg([subagent]))).toBe(false);
  });

  it('keeps an unresolved speculation live', () => {
    const speculating = { type: 'speculation', state: 'predicting' } as ContentBlock;
    const used = { type: 'speculation', state: 'used' } as ContentBlock;
    expect(isMessageSettled(msg([speculating]))).toBe(false);
    expect(isMessageSettled(msg([used]))).toBe(true);
  });

  it('does not treat thinking text as in-flight', () => {
    // Thinking content is appended to, but the block is never mutated in a way
    // that rewrites rows already printed.
    expect(isMessageSettled(msg([{ type: 'thinking', content: 'hmm' }]))).toBe(true);
  });
});

describe('splitTranscript', () => {
  it('commits nothing when the only message is still live', () => {
    const messages = [msg([tool('executing')])];
    const { committed, live } = splitTranscript(messages);
    expect(committed).toHaveLength(0);
    expect(live).toEqual(messages);
  });

  it('holds back the newest message even when it is settled', () => {
    // The newest message is the one an out-of-band tool result is most likely
    // to touch, so it is worth one extra frame of caution.
    const a = msg([text('a')]);
    const b = msg([text('b')]);
    const { committed, live } = splitTranscript([a, b]);
    expect(committed).toEqual([a]);
    expect(live).toEqual([b]);
  });

  it('stops at the first unsettled message, not at the last settled one', () => {
    // Ordering matters: scrollback is append-only, so a later settled message
    // cannot jump ahead of an earlier live one.
    const settled = msg([text('done')]);
    const running = msg([tool('executing')]);
    const laterSettled = msg([text('also done')]);
    const newest = msg([text('newest')]);

    const { committed, live } = splitTranscript([settled, running, laterSettled, newest]);
    expect(committed).toEqual([settled]);
    expect(live).toEqual([running, laterSettled, newest]);
  });

  it('never commits a message that a late tool result could still mutate', () => {
    // SET_TOOL_USE_RESULT / UPDATE_BLOCK_STATE scan ALL messages by toolId, so
    // a long-running tool keeps its message live no matter how old it is.
    const old = msg([tool('executing', 'long-running')]);
    const many = Array.from({ length: 20 }, () => msg([text()]));
    const { committed, live } = splitTranscript([old, ...many]);
    expect(committed).toHaveLength(0);
    expect(live).toHaveLength(21);
  });

  it('partitions without loss or reordering', () => {
    const messages = [msg([text('1')]), msg([text('2')]), msg([tool('pending')]), msg([text('4')])];
    const { committed, live } = splitTranscript(messages);
    expect([...committed, ...live]).toEqual(messages);
  });

  it('handles an empty transcript', () => {
    const { committed, live } = splitTranscript([]);
    expect(committed).toHaveLength(0);
    expect(live).toHaveLength(0);
  });

  it('respects keepLive=0 for callers that want everything committable', () => {
    const a = msg([text('a')]);
    const b = msg([text('b')]);
    expect(splitTranscript([a, b], 0).committed).toEqual([a, b]);
  });

  it('does not let keepLive push the boundary negative', () => {
    const only = msg([text()]);
    const { committed, live } = splitTranscript([only], 5);
    expect(committed).toHaveLength(0);
    expect(live).toEqual([only]);
  });
});

describe('advanceEpoch', () => {
  const base = { renderRevision: 0, committedCount: 0, subAgentId: undefined };

  it('keeps the same token while history only grows', () => {
    // This is the property that keeps output linear. Remounting on append would
    // reprint the whole transcript every message.
    const epoch = initialEpoch();
    const first = advanceEpoch(epoch, { ...base, committedCount: 1 });
    const second = advanceEpoch(first, { ...base, committedCount: 2 });
    const third = advanceEpoch(second, { ...base, committedCount: 99 });
    expect(second.token).toBe(first.token);
    expect(third.token).toBe(first.token);
  });

  it('starts out already in sync with a fresh transcript', () => {
    // initialEpoch must agree with the first advanceEpoch call, or the very
    // first frame would reprint an empty transcript for no reason.
    const epoch = initialEpoch();
    expect(advanceEpoch(epoch, base)).toBe(epoch);
  });

  it('is stable when nothing changes at all', () => {
    const first = advanceEpoch(initialEpoch(), { ...base, committedCount: 3 });
    expect(advanceEpoch(first, { ...base, committedCount: 3 })).toBe(first);
  });

  it('reprints when the expand-all toggle bumps the render revision', () => {
    const before = advanceEpoch(initialEpoch(), { ...base, committedCount: 5 });
    const after = advanceEpoch(before, { ...base, committedCount: 5, renderRevision: 1 });
    expect(after.token).not.toBe(before.token);
  });

  it('reprints on every successive toggle, not just the first', () => {
    // A boolean would settle after one flip; the counter must keep moving so
    // collapse-then-expand-again is also honoured.
    let epoch = advanceEpoch(initialEpoch(), { ...base, committedCount: 5 });
    const tokens = new Set([epoch.token]);
    for (let revision = 1; revision <= 4; revision += 1) {
      epoch = advanceEpoch(epoch, { ...base, committedCount: 5, renderRevision: revision });
      expect(tokens.has(epoch.token)).toBe(false);
      tokens.add(epoch.token);
    }
  });

  it('reprints when history shrinks (clear / undo / resume / trim)', () => {
    const grown = advanceEpoch(initialEpoch(), { ...base, committedCount: 10 });
    const cleared = advanceEpoch(grown, { ...base, committedCount: 0 });
    expect(cleared.token).not.toBe(grown.token);
    // The high-water mark must follow the shrink, or the next growth would be
    // misread as a further shrink and reprint again.
    expect(cleared.highWaterMark).toBe(0);
  });

  it('reprints when switching into and out of a sub-agent view', () => {
    const main = advanceEpoch(initialEpoch(), { ...base, committedCount: 4 });
    const sub = advanceEpoch(main, { ...base, committedCount: 2, subAgentId: 'agent-7' });
    expect(sub.token).not.toBe(main.token);
    const backToMain = advanceEpoch(sub, { ...base, committedCount: 4 });
    expect(backToMain.token).not.toBe(sub.token);
  });

  it('does not confuse a sub-agent id with a revision bump', () => {
    // The scope is built from two fields; an id that happens to contain the
    // separator must not be able to forge a different scope.
    const main = advanceEpoch(initialEpoch(), { ...base, committedCount: 1 });
    const spoofed = advanceEpoch(main, {
      ...base,
      committedCount: 1,
      subAgentId: 'main 0',
      renderRevision: 0,
    });
    // 'main 0' is a genuinely different transcript, so it MUST reprint.
    expect(spoofed.token).not.toBe(main.token);
    // And staying there must then be stable.
    expect(
      advanceEpoch(spoofed, { ...base, committedCount: 1, subAgentId: 'main 0' }),
    ).toBe(spoofed);
  });

  it('never reuses a token after a reprint', () => {
    // Returning to a previous scope must still yield a fresh key, otherwise
    // React would reuse the old <Static> instance and skip the reprint.
    let epoch = initialEpoch();
    const seen = new Set<string>([epoch.token]);
    for (let i = 0; i < 6; i += 1) {
      epoch = advanceEpoch(epoch, {
        ...base,
        committedCount: 3,
        // Flip back and forth between the same two scopes.
        subAgentId: i % 2 === 0 ? 'agent-a' : undefined,
      });
      expect(seen.has(epoch.token)).toBe(false);
      seen.add(epoch.token);
    }
  });

  it('tracks the high-water mark across a shrink and regrowth', () => {
    let epoch = advanceEpoch(initialEpoch(), { ...base, committedCount: 8 });
    const tokenAfterGrowth = epoch.token;
    epoch = advanceEpoch(epoch, { ...base, committedCount: 2 });
    const tokenAfterShrink = epoch.token;
    expect(tokenAfterShrink).not.toBe(tokenAfterGrowth);
    // Regrowth from the new baseline must NOT trigger another reprint.
    epoch = advanceEpoch(epoch, { ...base, committedCount: 5 });
    expect(epoch.token).toBe(tokenAfterShrink);
  });
});

/**
 * `shouldFlush` exists because committing is VISIBLE, not free. Ink clears the
 * interactive region, writes the static rows, then repaints — and that clear is
 * sized from the previous frame's line count, so a flush can strand a row of
 * stale chrome on screen. Flushing once per settled message therefore produced a
 * duplicated status bar; flushing only when the live half runs out of room does
 * not.
 *
 * So these tests are about the POLICY being stingy. `splitTranscript` already
 * covers the safety rule (never commit something that can still change).
 */
describe('shouldFlush', () => {
  const room = { liveContentRows: 5, liveRegionRows: 40, alreadyCommitted: 3 };

  it('does not flush while the live half still has room', () => {
    // The bug this fixes: 4 settled messages and a nearly-empty frame is not a
    // reason to pay for a flush.
    expect(shouldFlush({ ...room, committableCount: 4 })).toBe(0);
  });

  it('flushes once the live half approaches its limit', () => {
    expect(
      shouldFlush({ ...room, committableCount: 4, liveContentRows: 30 }),
    ).toBe(4);
  });

  it('flushes immediately before anything has been committed', () => {
    // The banner is the first static item; holding it back would keep ~20 rows
    // of never-changing output in the repainted frame.
    expect(
      shouldFlush({ ...room, committableCount: 1, alreadyCommitted: 0, liveContentRows: 1 }),
    ).toBe(1);
  });

  it('stays put when there is nothing new to commit', () => {
    expect(shouldFlush({ ...room, committableCount: 3, liveContentRows: 39 })).toBe(0);
    // Not even if the count went backwards — a shrink is handled by the epoch,
    // and re-committing fewer rows is not something scrollback can express.
    expect(shouldFlush({ ...room, committableCount: 1, liveContentRows: 39 })).toBe(0);
  });

  it('scales its threshold with the live region, not a fixed row count', () => {
    // 8 rows of content is comfortable in a 40-row region and cramped in a
    // 10-row one. A hard-coded threshold would get one of the two wrong.
    expect(
      shouldFlush({ committableCount: 9, alreadyCommitted: 3, liveContentRows: 8, liveRegionRows: 40 }),
    ).toBe(0);
    expect(
      shouldFlush({ committableCount: 9, alreadyCommitted: 3, liveContentRows: 8, liveRegionRows: 10 }),
    ).toBe(9);
  });

  it('still flushes in a region too small for any fraction to apply', () => {
    // floor(1 * 0.75) is 0; the threshold has to stay at least 1 or a one-row
    // region would flush on every single frame.
    expect(
      shouldFlush({ committableCount: 4, alreadyCommitted: 3, liveContentRows: 1, liveRegionRows: 1 }),
    ).toBe(4);
    expect(
      shouldFlush({ committableCount: 4, alreadyCommitted: 3, liveContentRows: 0, liveRegionRows: 1 }),
    ).toBe(0);
  });
});
