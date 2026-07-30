/**
 * auto-compact.ts — Automatic compaction triggering and circuit breaker.
 *
 * Ported from claude-code-best's autoCompact.ts. Handles:
 * - Token threshold computation (model-aware)
 * - shouldAutoCompact() decision logic
 * - Circuit breaker: disables auto-compact after N consecutive failures
 * - autoCompactIfNeeded() entry point called from the query loop
 */

import {
  COMPACT_MAX_OUTPUT_TOKENS,
  AUTOCOMPACT_BUFFER_TOKENS_DEFAULT,
  AUTOCOMPACT_BUFFER_TOKENS_LARGE,
  AUTOCOMPACT_BUFFER_TOKENS_XLARGE,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from './compact-types.js';
import type { AutoCompactTrackingState, CompactionResult } from './compact-types.js';
import { tokenCountWithEstimation } from '../token-budget.js';
import type { Message } from '../types.js';

// ---------------------------------------------------------------------------
// Context window lookup
// ---------------------------------------------------------------------------

/** Default context window when model-specific is unavailable. */
const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;

/**
 * Get the context window size for a given model.
 * Maps known model families to their context windows.
 */
function getContextWindowForModel(model: string): number {
  const lower = model.toLowerCase();

  // Claude 4.x models
  if (lower.includes('claude')) {
    if (lower.includes('opus-4-7') || lower.includes('opus-4.7')) return 200_000;
    if (lower.includes('opus')) return 200_000;
    if (lower.includes('sonnet')) return 200_000;
    if (lower.includes('haiku-4-5')) return 200_000;
    if (lower.includes('haiku')) return 200_000;
    return MODEL_CONTEXT_WINDOW_DEFAULT;
  }

  // GPT models
  if (lower.includes('gpt-4')) return 128_000;
  if (lower.includes('gpt-4o')) return 128_000;
  if (lower.includes('o1') || lower.includes('o3')) return 200_000;

  // DeepSeek models
  if (lower.includes('deepseek')) return 128_000;

  // Gemini models
  if (lower.includes('gemini-2')) return 1_048_576;
  if (lower.includes('gemini')) return 128_000;

  return MODEL_CONTEXT_WINDOW_DEFAULT;
}

// ---------------------------------------------------------------------------
// Threshold computation
// ---------------------------------------------------------------------------

/**
 * Get the auto-compact buffer based on the effective context window.
 * Larger windows get proportionally larger buffers.
 */
function getAutocompactBufferTokens(model: string): number {
  const window = getContextWindowForModel(model);
  if (window >= 800_000) return AUTOCOMPACT_BUFFER_TOKENS_XLARGE;
  if (window >= 400_000) return AUTOCOMPACT_BUFFER_TOKENS_LARGE;
  return AUTOCOMPACT_BUFFER_TOKENS_DEFAULT;
}

/**
 * Compute the absolute token threshold above which auto-compact triggers.
 *
 * Formula: effectiveWindow - buffer
 * Where effectiveWindow = contextWindow - COMPACT_MAX_OUTPUT_TOKENS
 *
 * Can be overridden by CODERIX_AUTOCOMPACT_PCT_OVERRIDE env var (1-100).
 */
export function getAutoCompactThreshold(model: string): number {
  const contextWindow = getContextWindowForModel(model);
  const effectiveWindow = contextWindow - COMPACT_MAX_OUTPUT_TOKENS;
  const buffer = getAutocompactBufferTokens(model);

  // Allow percentage override
  const pctOverride = process.env.CODERIX_AUTOCOMPACT_PCT_OVERRIDE;
  if (pctOverride) {
    const pct = Number.parseInt(pctOverride, 10);
    if (pct > 0 && pct <= 100) {
      return Math.floor(effectiveWindow * (pct / 100));
    }
  }

  return effectiveWindow - buffer;
}

// ---------------------------------------------------------------------------
// Auto-compact gating
// ---------------------------------------------------------------------------

/**
 * Check whether auto-compact is enabled by config and env.
 */
export function isAutoCompactEnabled(): boolean {
  if (process.env.DISABLE_COMPACT || process.env.DISABLE_AUTO_COMPACT) {
    return false;
  }
  return true;
}

/**
 * Should auto-compact trigger given the current message array?
 *
 * Guards:
 * 1. Auto-compact must be enabled
 * 2. Token count must exceed the model-aware threshold
 * 3. Does NOT check circuit breaker — that's the caller's responsibility
 */
export function shouldAutoCompact(
  messages: Message[],
  model: string,
  snipTokensFreed: number = 0,
): boolean {
  if (!isAutoCompactEnabled()) {
    return false;
  }

  const currentTokens = tokenCountWithEstimation(messages) - snipTokensFreed;
  const threshold = getAutoCompactThreshold(model);

  return currentTokens > threshold;
}

// ---------------------------------------------------------------------------
// Auto-compact entry point (circuit breaker + delegation)
// ---------------------------------------------------------------------------

/**
 * Try to auto-compact the conversation. This is called from the query loop
 * at the end of each turn when the token threshold is exceeded.
 *
 * Order of attempts:
 * 1. Session Memory Compact (zero API cost) — if available
 * 2. LLM Summarization Compact (full compact)
 *
 * Circuit breaker:
 * - After MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES consecutive failures,
 *   auto-compact is disabled for the rest of the session.
 * - Manual /compact resets the counter.
 */
export async function autoCompactIfNeeded(
  messages: Message[],
  model: string,
  compactFn: {
    trySessionMemoryCompact: (
      cwd: string,
      messages: Message[],
      threshold?: number,
    ) => Promise<CompactionResult | null>;
    compactConversation: (
      messages: Message[],
      options: {
        signal: AbortSignal;
        preCompactTokens: number;
        model: string;
        customInstructions?: string;
      },
    ) => Promise<CompactionResult>;
  },
  options: {
    cwd: string;
    signal: AbortSignal;
    tracking: AutoCompactTrackingState;
    snipTokensFreed?: number;
  },
): Promise<{
  wasCompacted: boolean;
  compactionResult?: CompactionResult;
  consecutiveFailures: number;
}> {
  // DISABLE_COMPACT gate
  if (process.env.DISABLE_COMPACT) {
    return {
      wasCompacted: false,
      consecutiveFailures: options.tracking.consecutiveFailures ?? 0,
    };
  }

  // Circuit breaker
  const failures = options.tracking.consecutiveFailures ?? 0;
  if (failures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return { wasCompacted: false, consecutiveFailures: failures };
  }

  // Threshold check
  if (!shouldAutoCompact(messages, model, options.snipTokensFreed)) {
    return { wasCompacted: false, consecutiveFailures: failures };
  }

  const preTokens = tokenCountWithEstimation(messages);

  try {
    // Step 1: Try session memory compact (zero API cost)
    const smResult = await compactFn.trySessionMemoryCompact(
      options.cwd,
      messages,
      getAutoCompactThreshold(model),
    );
    if (smResult) {
      return {
        wasCompacted: true,
        compactionResult: smResult,
        consecutiveFailures: 0,
      };
    }

    // Step 2: Full LLM summarization compact
    const result = await compactFn.compactConversation(messages, {
      signal: options.signal,
      preCompactTokens: preTokens,
      model,
    });

    return {
      wasCompacted: true,
      compactionResult: result,
      consecutiveFailures: 0,
    };
  } catch (error) {
    const newFailures = failures + 1;
    if (newFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      // Circuit breaker tripped — log it
      console.error(
        `[auto-compact] Circuit breaker tripped after ${newFailures} consecutive failures. ` +
          `Auto-compact disabled for this session. Manual /compact still works.`,
      );
    }
    return {
      wasCompacted: false,
      consecutiveFailures: newFailures,
    };
  }
}

/**
 * Notify the auto-compact system that the circuit breaker should be reset.
 * Called after a successful manual /compact.
 */
export function resetCircuitBreaker(
  tracking: AutoCompactTrackingState,
): void {
  tracking.consecutiveFailures = 0;
}
