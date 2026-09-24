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
