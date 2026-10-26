import { describe, expect, it } from 'vitest';
import { resolveAutoCompactWindow } from '../auto-compact-window.js';

// Headroom the CLI subtracts from an explicitly configured window before it
// compares against live context usage.
const CLI_OUTPUT_RESERVE = 20_000;
const CLI_PROMPT_RESERVE = 13_000;

/** Mirrors how the CLI turns the window we pass into its compaction trigger. */
function cliTrigger(window: number, maxContext: number): number {
  const effective = Math.min(maxContext, window) - CLI_OUTPUT_RESERVE;
  return effective - CLI_PROMPT_RESERVE;
}

describe('resolveAutoCompactWindow', () => {
  it('compensates the CLI reserves so 512K × 0.85 triggers at 85%', () => {
    const maxContext = 512_000;
    const window = resolveAutoCompactWindow(maxContext, 0.85)!;

    expect(window).toBe(468_200);
    expect(cliTrigger(window, maxContext)).toBe(Math.round(maxContext * 0.85));
  });

  it('honours a custom ratio', () => {
    const maxContext = 512_000;
    const window = resolveAutoCompactWindow(maxContext, 0.7)!;

    expect(cliTrigger(window, maxContext)).toBe(Math.round(maxContext * 0.7));
  });

  it('never asks for a window above the configured context size', () => {
    const maxContext = 200_000;
    const window = resolveAutoCompactWindow(maxContext, 0.85)!;

    expect(window).toBe(200_000);
    expect(cliTrigger(window, maxContext)).toBe(167_000);
  });

  it('stays inside the range the CLI accepts', () => {
    expect(resolveAutoCompactWindow(64_000, 0.85)).toBe(100_000);
    expect(resolveAutoCompactWindow(2_000_000, 0.85)).toBe(1_000_000);
  });

  it('falls back to 0.85 when the ratio is invalid', () => {
    expect(resolveAutoCompactWindow(512_000, 0)).toBe(
      resolveAutoCompactWindow(512_000, 0.85),
    );
    expect(resolveAutoCompactWindow(512_000, 1.5)).toBe(
      resolveAutoCompactWindow(512_000, 0.85),
    );
    expect(resolveAutoCompactWindow(512_000, undefined)).toBe(
      resolveAutoCompactWindow(512_000, 0.85),
    );
  });

  it('returns undefined when the model declares no context window', () => {
    expect(resolveAutoCompactWindow(undefined, 0.85)).toBeUndefined();
    expect(resolveAutoCompactWindow(0, 0.85)).toBeUndefined();
    expect(resolveAutoCompactWindow(-1, 0.85)).toBeUndefined();
  });
});
