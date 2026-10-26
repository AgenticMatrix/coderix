/**
 * auto-compact-window.ts — resolve the Claude Code auto-compact window for a
 * model whose context size Coderix knows but the CLI does not.
 *
 * The spawned `claude` CLI assumes a 200K window for any model id it doesn't
 * recognise, and — because that assumption is untrusted — it refuses to
 * auto-compact proactively (`shouldAutoCompact` bails when the resolved window
 * source is "auto"). A Coderix model bound to a third-party endpoint is always
 * such an id, so without an explicit window the context grows until the
 * provider itself errors.
 *
 * Handing the CLI two values fixes that:
 *   - `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — the model's configured window, so the
 *     CLI stops assuming 200K;
 *   - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — an explicit window, which flips the
 *     window source off "auto" and re-enables compaction.
 */

/** The CLI accepts auto-compact windows between 100K and 1M tokens. */
const WINDOW_MIN = 100_000;
const WINDOW_MAX = 1_000_000;

/**
 * Headroom the CLI subtracts below the auto-compact window before comparing it
 * with the live context size:
 *   window' = window - min(maxOutputTokens, 20_000)
 *   trigger = window' - 13_000
 * Both are hard-coded in the CLI, so a window equal to the desired trigger
 * fires 33K tokens early; `resolveAutoCompactWindow` adds them back.
 */
const OUTPUT_RESERVE = 20_000;
const PROMPT_RESERVE = 13_000;

const DEFAULT_THRESHOLD = 0.85;

/**
 * Compute the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` value that makes the CLI
 * compact at `maxContext * threshold`.
 *
 * Windows under ~220K cannot absorb both reserves while staying below the
 * configured context size; for those the window is capped at `maxContext` and
 * the trigger lands at `maxContext - 33K`, the earliest the CLI allows.
 *
 * Returns undefined when the model has no configured context size — the CLI
 * then keeps its own defaults (and, for an unknown model, stays silent).
 */
export function resolveAutoCompactWindow(
  maxContext: number | undefined,
  threshold: number | undefined,
): number | undefined {
  if (!maxContext || maxContext <= 0) return undefined;

  const ratio =
    threshold !== undefined && threshold > 0 && threshold <= 1
      ? threshold
      : DEFAULT_THRESHOLD;
  const trigger = Math.round(maxContext * ratio);
  const compensated = trigger + OUTPUT_RESERVE + PROMPT_RESERVE;
  // Never let the CLI compact above the window the model actually has.
  const capped = Math.min(maxContext, compensated);
  return Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, capped));
}
