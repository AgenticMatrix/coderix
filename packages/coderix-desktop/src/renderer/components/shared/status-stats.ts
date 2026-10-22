import type { AggregatedTokenUsage, ChatMessage } from '../../store/types.js';

/**
 * Display helpers for the status bar's session/token stat pills.
 *
 * Kept free of React and of the i18n store so the numbers can be unit-tested:
 * every function here is pure and deterministic.
 */

/** The three disjoint prompt-side billing buckets plus the output bucket. */
export function billedInputTokens(usage: AggregatedTokenUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Session total across every billing bucket (prompt buckets + output). */
export function totalBillableTokens(usage: AggregatedTokenUsage): number {
  return billedInputTokens(usage) + usage.outputTokens;
}

/**
 * Cache-hit share of the prompt side, truncated rather than rounded so a
 * partial hit can never read as a full 100%.
 *
 * @param cacheReadTokens - prompt tokens served from cache.
 * @param promptTokens - all prompt-side tokens (uncached + cache read + cache write).
 * @param decimals - 0 or 1 fractional digit.
 * @returns percentage text, or null when there was no prompt input.
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimals: 0 | 1 = 1,
): string | null {
  if (!(promptTokens > 0)) return null;
  const hit = Math.min(Math.max(cacheReadTokens, 0), promptTokens);
  if (hit >= promptTokens) return '100';

  const factor = decimals === 0 ? 1 : 10;
  const units = Math.floor((hit / promptTokens) * 100 * factor);
  const whole = Math.floor(units / factor);
  const fraction = units % factor;
  return fraction === 0 ? String(whole) : `${whole}.${fraction}`;
}

/** Cache-hit percentage for a session's aggregated usage. */
export function cacheHitPercent(usage: AggregatedTokenUsage, decimals: 0 | 1 = 1): string | null {
  return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage), decimals);
}

/** Integer token count with thousands separators, for the detail rows. */
export function formatExactTokens(value: number): string {
  const digits = String(Math.max(0, Math.round(value)));
  let out = '';
  for (let end = digits.length; end > 0; end -= 3) {
    const start = Math.max(0, end - 3);
    out = digits.slice(start, end) + (out ? `,${out}` : '');
  }
  return out;
}

/** Compact token count: 517 / 1.2K / 517K / 1.2M. */
export function formatCompactTokens(value: number): string {
  const scaled = (v: number): string =>
    String(v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  if (value < 1_000_000) {
    // 999,999 must read as 1M, not 1000K — promote once rounding crosses 999.5K.
    if (value >= 999_500) return `${scaled(value / 1_000_000)}M`;
    return `${scaled(value / 1_000)}K`;
  }
  return `${scaled(value / 1_000_000)}M`;
}

/** Elapsed seconds as 45s / 2m 42s / 1h 3m. */
export function formatStatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface SessionStats {
  /** User messages — one per conversation turn. */
  turns: number;
  /** Assistant messages — one per model step (`message_stop`). */
  steps: number;
  /** `tool_use` blocks across all assistant steps. */
  toolCalls: number;
  /** Timestamp of the oldest message, or null for an empty transcript. */
  startedAt: number | null;
}

/** Fold a session transcript into the counters the status bar shows. */
export function deriveSessionStats(messages: readonly ChatMessage[]): SessionStats {
  let turns = 0;
  let steps = 0;
  let toolCalls = 0;
  let startedAt: number | null = null;

  for (const message of messages) {
    if (startedAt === null || message.timestamp < startedAt) startedAt = message.timestamp;
    if (message.role === 'user') {
      turns += 1;
      continue;
    }
    if (message.role !== 'assistant') continue;
    steps += 1;
    for (const block of message.blocks) {
      if (block.type === 'tool_use') toolCalls += 1;
    }
  }

  return { turns, steps, toolCalls, startedAt };
}
