import { describe, it, expect } from 'vitest';
import { emulate, countRows } from '../testing/term-emulator.js';

/**
 * The emulator is only useful if it distinguishes an in-place repaint from a
 * stale frame. These cases pin that down against hand-written escapes whose
 * on-screen result is unambiguous.
 */
describe('terminal emulator', () => {
  it('overwrites a row when the cursor is moved back up onto it', () => {
    const screen = emulate('old\n\x1b[1A\x1b[2K\x1b[Gnew\n', 80, 10);
    expect(screen.rows).toEqual(['new']);
    expect(countRows(screen, 'old')).toBe(0);
  });

  it('leaves the old row on screen when the cursor is not moved back', () => {
    const screen = emulate('old\nnew\n', 80, 10);
    expect(screen.rows).toEqual(['old', 'new']);
  });

  it('erases only to the end of the line for ESC[K', () => {
    const screen = emulate('abcdef\r\x1b[3C\x1b[K', 80, 10);
    expect(screen.rows).toEqual(['abc']);
  });

  it('pushes rows into scrollback once the screen is full', () => {
    const screen = emulate('a\nb\nc\nd\n', 80, 2);
    expect(screen.scrollback).toContain('a');
    expect(screen.rows.length).toBeLessThanOrEqual(2);
  });

  /**
   * Every row must end up in exactly one of the two buffers. Asserting only
   * that scrollback CONTAINS the oldest row is too weak: it still passes when
   * rows are dropped on the floor, which is precisely how an off-by-one in the
   * scroll condition hides — the screen looks plausible and content is gone.
   */
  it('accounts for every row across repeated scrolling, losing none', () => {
    const written = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const screen = emulate(written.join('\n') + '\n', 80, 3);

    expect([...screen.scrollback, ...screen.rows].filter((r) => r !== '')).toEqual(written);
    // The newest rows are the ones still visible.
    expect(screen.rows).toEqual(['f', 'g']);
  });

  it('scrolls the cursor up with the content, so later writes land correctly', () => {
    // Fill past the bottom, then rewind one line and overwrite it. The target
    // is the LAST row, which is only true if scrolling moved the cursor too.
    const screen = emulate('a\nb\nc\nd\n\x1b[1A\x1b[2K\x1b[Gz', 80, 3);
    expect(screen.rows).toEqual(['c', 'z']);
  });

  it('clears the visible screen on ESC[2J', () => {
    const screen = emulate('a\nb\n\x1b[2Jz', 80, 10);
    expect(screen.rows).toEqual(['z']);
  });

  it('drops scrollback on ESC[3J', () => {
    const screen = emulate('a\nb\nc\nd\n\x1b[3J', 80, 2);
    expect(screen.scrollback).toEqual([]);
  });

  it('ignores SGR colour and private-mode sequences', () => {
    const screen = emulate('\x1b[?2026h\x1b[31mred\x1b[39m\x1b[?2026l', 80, 10);
    expect(screen.rows).toEqual(['red']);
  });
});
