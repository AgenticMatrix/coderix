/**
 * token-budget.ts — Token estimation utilities
 *
 * Provides a standalone, reusable token estimator for the Agent Loop's
 * context window management. Used by both query.ts (inline compaction
 * checks) and compactor.ts (strategy selection).
 *
 * Uses tiktoken (cl100k_base) for real token counting when available,
 * falling back to character-based estimation otherwise.
 */

import type { Message, ContentBlock, AssistantMessage } from './types.js';
import { countTokens, countContentTokens } from './token-counter.js';

// ---------------------------------------------------------------------------
// TokenBudget type (canonical definition)
// ---------------------------------------------------------------------------

export interface TokenBudget {
  /** Current estimated token count of the message array */
  current: number;
  /** Maximum allowed tokens for the context window */
  max: number;
  /** Ratio of current / max (0-1) */
  ratio: number;
  /** Percentage used (0-100), for display */
  percent: number;
}

// ---------------------------------------------------------------------------
// Token estimation functions
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a plain string.
 * Uses tiktoken when available, falls back to ~3.5 chars/token.
 */
export function estimateStringTokens(
  text: string,
  _contentType: 'text' | 'json' | 'code' = 'text',
): number {
  return countTokens(text);
}

/**
 * Estimate token count for a ContentBlock.
 *
 * Uses tiktoken for text and tool_result blocks.
 * Fallback weights when tiktoken is unavailable:
 *   - text: 3.5 chars/token
 *   - tool_use: 2.5 chars/token (structured input)
 *   - tool_result: 2.0 chars/token (tool output is often code/diff-like)
 *   - thinking: 3.5 chars/token
 *   - image: 85 tokens (rough estimate)
 */
export function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text': {
      const text = block.text ?? '';
      return countTokens(text);
    }

    case 'tool_use': {
      let total = 10; // Tool name + id overhead: ~10 tokens
      if (block.input) {
        total += estimateStringTokens(
          JSON.stringify(block.input),
          'json',
        );
      }
      return total;
    }

    case 'tool_result': {
      let total = 0;
      const content =
        typeof block.content === 'string'
          ? block.content
          : block.content
            ? block.content
            : undefined;
      if (content) {
        if (typeof content === 'string') {
          total += countTokens(content);
        } else if (Array.isArray(content)) {
          total += countContentTokens(content);
        }
      }
      if (block.is_error) total += 5;
      return total;
    }

    case 'thinking': {
      const thinking = block.thinking ?? '';
      return countTokens(thinking);
    }

    case 'image': {
      return block.source?.data
        ? Math.ceil(String(block.source.data).length / 50)
        : 85;
    }

    default:
      return 0;
  }
}

/**
 * Estimate token count for a single Message.
 *
 * Accounts for:
 *   - Role tag overhead (~4 tokens per message for API metadata)
 *   - Content blocks (counted via tiktoken)
 *   - String content fallback
 */
export function estimateMessageTokens(message: Message): number {
  // Base overhead per message (role tag, formatting tokens)
  let tokens = 4;

  if (typeof message.content === 'string') {
    tokens += countTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      tokens += estimateBlockTokens(block);
    }
  }

  return tokens;
}

/**
 * Estimate total token count for an array of messages.
 *
 * This is the main entry point — used by query.ts and compactor.ts
 * to decide whether context compaction is needed.
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  // Add 2% buffer for inter-message formatting tokens
  return Math.ceil(total * 1.02);
}

// ---------------------------------------------------------------------------
// TokenBudget factory
// ---------------------------------------------------------------------------

/**
 * Create a TokenBudget from a message array and a maximum budget.
 *
 * Usage:
 *   const budget = createTokenBudget(messages, 180_000);
 *   if (budget.ratio > 0.6) { /* trigger compaction *\/ }
 */
export function createTokenBudget(
  messages: Message[],
  maxTokens: number,
): TokenBudget {
  const current = estimateTokens(messages);
  const safeMax = Math.max(1, maxTokens);
  return {
    current,
    max: maxTokens,
    ratio: current / safeMax,
    percent: Math.min(100, Math.round((current / safeMax) * 100)),
  };
}

/**
 * Create a budget with a pre-computed token count.
 */
export function createTokenBudgetFromCount(
  currentTokens: number,
  maxTokens: number,
): TokenBudget {
  const safeMax = Math.max(1, maxTokens);
  return {
    current: currentTokens,
    max: maxTokens,
    ratio: currentTokens / safeMax,
    percent: Math.min(100, Math.round((currentTokens / safeMax) * 100)),
  };
}

/**
 * Check whether the token budget has been exceeded.
 */
export function isBudgetExceeded(budget: TokenBudget): boolean {
  return budget.ratio >= 1;
}

/**
 * Check whether compaction is recommended (budget > safe threshold).
 */
export function needsCompaction(
  budget: TokenBudget,
  threshold = 0.6,
): boolean {
  return budget.ratio > threshold;
}

// ---------------------------------------------------------------------------
// API-reported token count helpers
// ---------------------------------------------------------------------------

/**
 * Extract the total context token count from the last API response.
 *
 * Returns the sum of input_tokens + cache_read_input_tokens only.
 * This represents the actual input context size sent to the model:
 *   - input_tokens: tokens sent to the model (uncached portion)
 *   - cache_read_input_tokens: tokens served from the prompt cache
 *
 * output_tokens and cache_creation_input_tokens are excluded:
 *   - output_tokens are model-generated tokens (not part of the input context)
 *   - cache_creation_input_tokens are written to cache (billed but not read)
 *
 * With prompt caching (DeepSeek, Anthropic), input_tokens may be small
 * while cache_read is large -- the sum is the true context size.
 *
 * Returns undefined when no assistant message with usage data exists
 * (e.g., on the very first turn before any API call).
 */
export function tokenCountFromLastAPIResponse(
  messages: Message[],
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && 'usage' in msg) {
      const usage = (msg as AssistantMessage).usage;
      if (usage?.input_tokens && usage.input_tokens > 0) {
        return (
          usage.input_tokens +
          (usage.cache_read_input_tokens ?? 0)
        );
      }
    }
  }
  return undefined;
}

/**
 * Hybrid token counter: uses API-reported token counts when available,
 * falls back to tiktoken-based estimation.
 *
 * Uses the full context size from the last API response (input + cache + output).
 * This is a snapshot from the start of the last API call plus the model's
 * output -- it does not include tool results or other messages added since.
 * For compaction decisions this is safely conservative: we'll trigger
 * compaction slightly earlier than strictly necessary.
 */
export function tokenCountWithEstimation(messages: Message[]): number {
  const apiCount = tokenCountFromLastAPIResponse(messages);
  if (apiCount !== undefined) {
    return apiCount;
  }
  return estimateTokens(messages);
}
