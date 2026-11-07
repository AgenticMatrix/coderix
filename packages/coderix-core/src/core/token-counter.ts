/**
 * token-counter.ts — Real token counting via tiktoken (cl100k_base)
 *
 * Replaces the heuristic chars/token estimation in token-budget.ts with
 * actual tokenization using OpenAI's cl100k_base encoding (WASM, local-only).
 * Falls back to character-based estimation if tiktoken fails to initialize.
 */

import type { Tiktoken } from 'tiktoken';
import { truncateSafely, truncateMiddle } from '../utils/text-truncation.js';

// ---------------------------------------------------------------------------
// Lazy initialization
// ---------------------------------------------------------------------------

let _encoder: Tiktoken | null = null;
let _initError = false;

function getEncoder(): Tiktoken | null {
  if (_initError) return null;
  if (_encoder) return _encoder;

  try {
    // Dynamic import to avoid crashing when tiktoken isn't installed
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { get_encoding } = require('tiktoken') as typeof import('tiktoken');
    _encoder = get_encoding('cl100k_base');
    return _encoder;
  } catch {
    _initError = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count tokens in a string. Falls back to char-based estimation if tiktoken
 * is unavailable.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  const encoder = getEncoder();
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch {
      // Fall through to estimation
    }
  }
  // Fallback: ~3.5 chars/token for text
  return Math.ceil(text.length / 3.5);
}

/**
 * Count tokens in arbitrary content (string or content blocks).
 */
export function countContentTokens(
  content: string | Array<{ type: string; text?: string }>,
): number {
  if (typeof content === 'string') return countTokens(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      total += countTokens(block.text);
    }
  }
  return total;
}

/**
 * Truncate a string to at most `maxTokens` tokens.
 * Uses proportional estimation since tiktoken can't truncate directly.
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';

  const encoder = getEncoder();
  if (encoder) {
    try {
      const tokens = encoder.encode(text);
      if (tokens.length <= maxTokens) return text;

      // Binary search for the right cut point
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const slice = text.slice(0, mid);
        const count = encoder.encode(slice).length;
        if (count <= maxTokens) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      // The cut is chosen by token count, so it can land between the halves of
      // a surrogate pair; truncateSafely backs off to the pair boundary.
      return truncateSafely(text, lo);
    } catch {
      // Fall through to proportional
    }
  }

  // Fallback: proportional truncation (~3.5 chars/token)
  const maxChars = maxTokens * 3.5;
  return text.length <= maxChars ? text : truncateSafely(text, Math.floor(maxChars));
}

/**
 * Truncate a string to at most `maxTokens` tokens, keeping the tail.
 * Uses binary search with the real tokenizer when available.
 */
export function truncateToTokenLimitFromEnd(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';

  const encoder = getEncoder();
  if (encoder) {
    try {
      const tokens = encoder.encode(text);
      if (tokens.length <= maxTokens) return text;

      // Binary search: find the smallest prefix to drop
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const suffix = text.slice(mid);
        const count = encoder.encode(suffix).length;
        if (count <= maxTokens) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      // Keeping the tail means the cut moves to `lo`; a low surrogate stranded
      // at that index would be orphaned, so drop it (truncateMiddle does).
      return truncateMiddle(text, 0, text.length - lo, '');
    } catch {
      // Fall through to proportional
    }
  }

  // Fallback: proportional (~3.5 chars/token)
  const maxChars = maxTokens * 3.5;
  return text.length <= maxChars
    ? text
    : truncateMiddle(text, 0, Math.floor(maxChars), '');
}

/**
 * Check whether tiktoken is available.
 */
export function isTokenCounterAvailable(): boolean {
  return getEncoder() !== null;
}
