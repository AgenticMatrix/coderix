/**
 * microcompact.ts — Micro-compaction strategies.
 *
 * Two paths, ordered by invasiveness (least first):
 * 1. Time-Based Microcompact — clear old tool results when the server
 *    prompt cache has likely expired (>60 min gap since last interaction).
 * 2. (Future) Cached Microcompact — uses API cache_edits to delete tool
 *    results without breaking the cached prefix.
 *
 * Time-based microcompact is zero API cost and runs before every API call
 * when the condition is met.
 */

import type { Message, ContentBlock, ToolResultBlock } from '../types.js';
import {
  TIME_BASED_GAP_MINUTES,
  TIME_BASED_KEEP_RECENT,
  CLEARED_RESULT_MARKER,
  COMPACTABLE_TOOLS,
} from './compact-types.js';
import type { MicrocompactResult } from './compact-types.js';
import { countTokens } from '../token-counter.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply micro-compaction strategies to shrink context before an API call.
 *
 * Currently implements time-based microcompact only. Cached microcompact
 * (cache_edits API) can be added when the provider supports it.
 *
 * @param messages - Current messages before the API call.
 * @param lastUserInteractionTime - Timestamp of the last user interaction
 *   (milliseconds since epoch). If not provided, time-based MC is skipped.
 */
export async function microcompactMessages(
  messages: Message[],
  lastUserInteractionTime?: number,
): Promise<MicrocompactResult> {
  // Time-based trigger: check if server cache has likely expired
  const timeResult = maybeTimeBasedMicrocompact(
    messages,
    lastUserInteractionTime,
  );
  if (timeResult) {
    return timeResult;
  }

  return { strategy: 'none', removedCount: 0, savedTokens: 0, messages };
}

// ---------------------------------------------------------------------------
// Time-Based Micro Compact
// ---------------------------------------------------------------------------

function maybeTimeBasedMicrocompact(
  messages: Message[],
  lastInteractionTime?: number,
): MicrocompactResult | null {
  // Find the last assistant message to measure the gap
  const lastAssistant = findLastAssistantMessage(messages);
  if (!lastAssistant) {
    return null;
  }

  if (lastInteractionTime === undefined) {
    return null;
  }

  const now = Date.now();
  const gapMinutes = (now - lastInteractionTime) / 60_000;

  if (!Number.isFinite(gapMinutes) || gapMinutes < TIME_BASED_GAP_MINUTES) {
    return null;
  }

  // Collect compactable tool_use IDs in encounter order
  const compactableIds = collectCompactableToolIds(messages);

  // Keep the most recent N, clear the rest
  const keepSet = new Set(compactableIds.slice(-TIME_BASED_KEEP_RECENT));
  const clearSet = new Set(
    compactableIds.filter((id) => !keepSet.has(id)),
  );

  if (clearSet.size === 0) {
    return null;
  }

  let tokensSaved = 0;
  let clearedCount = 0;
  const clearedToolUseIds: string[] = [];

  const result: Message[] = messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      return message;
    }

    let touched = false;
    const newContent = message.content.map((block) => {
      if (
        block.type === 'tool_result' &&
        block.tool_use_id &&
        clearSet.has(block.tool_use_id) &&
        isToolResultClearable(block)
      ) {
        tokensSaved += estimateBlockTokensForResult(block);
        touched = true;
        clearedCount++;
        clearedToolUseIds.push(block.tool_use_id);
        return {
          ...block,
          content: CLEARED_RESULT_MARKER,
        } as ToolResultBlock;
      }
      return block;
    });

    if (!touched) return message;
    return {
      ...message,
      content: newContent,
    };
  });

  if (tokensSaved === 0) {
    return null;
  }

  return {
    strategy: 'time_based',
    removedCount: clearedCount,
    savedTokens: tokensSaved,
    messages: result,
    clearedToolUseIds,
  };
}

// ---------------------------------------------------------------------------
// Helpers — Message inspection
// ---------------------------------------------------------------------------

function findLastAssistantMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      return messages[i];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers — Tool ID collection
// ---------------------------------------------------------------------------

function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          block.type === 'tool_use' &&
          block.name &&
          COMPACTABLE_TOOLS.has(block.name) &&
          block.id
        ) {
          ids.push(block.id);
        }
      }
    }
  }
  return ids;
}

function isToolResultClearable(block: ContentBlock): boolean {
  // Already cleared — don't double-count
  if (
    typeof block.content === 'string' &&
    block.content === CLEARED_RESULT_MARKER
  ) {
    return false;
  }
  // Empty content — nothing to clear
  if (!block.content || block.content === '') {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helpers — Token estimation for tool results
// ---------------------------------------------------------------------------

/** Rough token estimate for an image block (conservative default). */
const IMAGE_TOKEN_ESTIMATE = 85;

function estimateBlockTokensForResult(block: ContentBlock): number {
  if (!block.content) {
    return 0;
  }

  if (typeof block.content === 'string') {
    return countTokens(block.content);
  }

  // Array of text/image blocks
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') {
      return sum + countTokens(item.text ?? '');
    }
    if (item.type === 'image') {
      return sum + IMAGE_TOKEN_ESTIMATE;
    }
    return sum;
  }, 0);
}
