import { describe, it, expect } from 'vitest';
import { shouldFlush } from '../transcript-commit.js';

/**
 * `shouldFlush` asks "is the live half running out of room?" — and that
 * question is only answerable if `liveRegionRows` is the region's CAPACITY.
 *
 * The live region shrinks to its content (so a short reply sits directly under
 * the turn it answers, with no dead rows above or below it). A shrunk box's
 * measured height IS its content height, so passing it here makes the policy
 * compare content against itself: always equal, always "full", flush on every
 * frame. That is precisely the per-message flushing the policy exists to
 * prevent — each flush clears the interactive region, writes the static rows
 * and repaints, and the clear is sized from the previous frame, so a stale row
 * of chrome can survive it.
 *
 * So the capacity has to come from something that does not shrink with the
 * content. These tests pin that distinction, since both numbers are plausible
 * row counts and swapping them produces no type error.
 */
describe('the flush policy needs capacity, not the shrunk height', () => {
  it('never flushes when handed the shrunk height as the capacity', () => {
    // The defect, stated directly: a shrunk region reports capacity == content.
    for (const contentRows of [1, 3, 8, 17, 40]) {
      expect(
        shouldFlush({
          committableCount: 5,
          alreadyCommitted: 1,
          liveContentRows: contentRows,
          liveRegionRows: contentRows,
        }),
        `content ${contentRows} == capacity ${contentRows} always reads as full`,
      ).toBe(5);
    }
  });

  it('holds still when the capacity is the real ceiling and the content is short', () => {
    // The same three messages, with capacity measured from the region's
    // ceiling rather than from the content: no flush, because there is room.
    expect(
      shouldFlush({
        committableCount: 5,
        alreadyCommitted: 1,
        liveContentRows: 3,
        liveRegionRows: 23,
      }),
    ).toBe(0);
  });

  it('still flushes once the content genuinely crowds the ceiling', () => {
    expect(
      shouldFlush({
        committableCount: 5,
        alreadyCommitted: 1,
        liveContentRows: 18,
        liveRegionRows: 23,
      }),
    ).toBe(5);
  });
});

/**
 * `eager` bypasses the capacity wait.
 *
 * The 75% policy trades flush-flicker against the room a flush buys, on the
 * assumption that a committable message is safe to leave sitting in the live
 * region for a few more frames. A newly-arrived user message breaks that
 * assumption: it is inert and clipped by the sticky-bottom live window, so a
 * frame spent uncommitted is a frame it is INVISIBLE — and unrecoverable, since
 * only `<Static>` reaches terminal scrollback. The call site sets `eager` when
 * the committable prefix just gained a user message, and the one flush is
 * cheaper than a vanished row.
 */
describe('eager flush for a newly-committable user message', () => {
  it('commits the whole prefix even when the content is short (room to spare)', () => {
    // Without eager this returns 0 (there is room — see the test above).
    expect(
      shouldFlush({
        committableCount: 5,
        alreadyCommitted: 1,
        liveContentRows: 3,
        liveRegionRows: 23,
        eager: true,
      }),
    ).toBe(5);
  });

  it('is a no-op when there is nothing new to commit, eager or not', () => {
    expect(
      shouldFlush({
        committableCount: 2,
        alreadyCommitted: 2,
        liveContentRows: 3,
        liveRegionRows: 23,
        eager: true,
      }),
    ).toBe(0);
  });

  it('matches the normal path once the content already crowds the ceiling', () => {
    // When a flush was due anyway, eager changes nothing.
    expect(
      shouldFlush({
        committableCount: 5,
        alreadyCommitted: 1,
        liveContentRows: 18,
        liveRegionRows: 23,
        eager: true,
      }),
    ).toBe(5);
  });
});
