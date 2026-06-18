/**
 * Compactor — Micro-compaction and token-aware context truncation.
 *
 * Two strategies, both purely client-side (zero API cost):
 *
 * 1. Time-Based Micro Compact
 *    When the gap since the last assistant message exceeds 60 minutes,
 *    the server-side prompt cache has expired. We content-clear old
 *    compactable tool results in-place to shrink what gets rewritten.
 *    Keeps the most recent N results intact.
 *
 * 2. Token-Aware Truncation
 *    Replaces the fixed "keep last 30 messages" with a token-budgeted
 *    approach: keep min 10K / max 40K tokens, at least 5 text-bearing
 *    messages, and never split tool_use/tool_result pairs or thinking
 *    blocks that share a message.id.
 */

import { estimateMessageTokens } from './token-budget.js';
import type { Message, ContentBlock, ToolResultBlock } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Time gap (minutes) since last assistant message to trigger time-based MC. */
const TIME_BASED_GAP_MINUTES = 60;

/** Number of most-recent compactable tool results to keep during time-based MC. */
const TIME_BASED_KEEP_RECENT = 5;

/** Placeholder text inserted in place of cleared tool results. */
const CLEARED_RESULT_MARKER = '[Old tool result content cleared]';

/** Tool names whose results are safe to clear during micro-compaction. */
const COMPACTABLE_TOOLS = new Set<string>([
  'read',
  'bash',
  'grep',
  'glob',
  'web-search',
  'web-fetch',
  'edit',
  'write',
]);

/**
 * Rough token estimate for an image block (conservative default).
 * Used when image blocks exist but we don't have exact source data size.
 */
const IMAGE_TOKEN_ESTIMATE = 85;

// ── Truncation budget constants ────────────────────────────────────────

/** Minimum tokens to preserve after truncation. */
const MIN_KEEP_TOKENS = 10_000;

/** Maximum tokens to preserve after truncation (hard cap). */
const MAX_KEEP_TOKENS = 40_000;

/** Minimum number of messages with text blocks to keep. */
const MIN_TEXT_BLOCK_MESSAGES = 5;

// ---------------------------------------------------------------------------
// Compactor interface
// ---------------------------------------------------------------------------

export interface CompactorConfig {
  estimateTokens: (messages: Message[]) => number;
  summarizeEnabled: boolean;
}

export interface MicrocompactResult {
  strategy: 'none' | 'time_based' | 'token_snip';
  removedCount: number;
  savedTokens: number;
  messages: Message[];
}

export interface TruncationResult {
  messages: Message[];
  /** Number of messages dropped from the head. */
  droppedCount: number;
  /** Estimated tokens saved. */
  savedTokens: number;
}

export class Compactor {
  private config: CompactorConfig;

  constructor(config: CompactorConfig) {
    this.config = config;
  }

  /**
   * Apply micro-compaction strategies to shrink context before an API call.
   *
   * Currently implements time-based microcompact only. Cache-edit-based
   * microcompact requires API support (Anthropic cache_edits) and can be
   * added when the provider supports it.
   */
  async microcompact(
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

  // Derive timestamp from the message if it has one, or use the provided
  // interaction time. The Message type currently has no timestamp field,
  // so we rely on the parameter passed by the caller.
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
  };
}

// ---------------------------------------------------------------------------
// Token-Aware Truncation
// ---------------------------------------------------------------------------

/**
 * Calculate the starting index for messages to keep after truncation.
 *
 * Expands backwards from the end of the message array to meet minimums:
 * - At least MIN_KEEP_TOKENS tokens
 * - At least MIN_TEXT_BLOCK_MESSAGES messages with text blocks
 * Stops expanding if MAX_KEEP_TOKENS is reached.
 * Then adjusts to preserve tool_use/tool_result pairs and thinking blocks.
 *
 * @param messages - Full message array
 * @returns The index to slice from (messages.slice(startIndex))
 */
export function calculateMessagesToKeepIndex(messages: Message[]): number {
  if (messages.length === 0) {
    return 0;
  }

  // Start from the end — keep nothing initially, expand backwards
  let startIndex = messages.length;
  let totalTokens = 0;
  let textBlockMsgCount = 0;

  // Count backwards from the last message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    totalTokens += estimateMessageTokens(msg);
    if (hasTextBlocks(msg)) {
      textBlockMsgCount++;
    }
    startIndex = i;

    // Stop if we hit the max cap
    if (totalTokens >= MAX_KEEP_TOKENS) {
      break;
    }

    // Stop if we meet both minimums
    if (
      totalTokens >= MIN_KEEP_TOKENS &&
      textBlockMsgCount >= MIN_TEXT_BLOCK_MESSAGES
    ) {
      break;
    }
  }

  // Adjust to preserve API invariants
  return adjustIndexToPreservePairs(messages, startIndex);
}

/**
 * Adjust the start index to ensure we don't split:
 * 1. tool_use/tool_result pairs — if a kept message has tool_results,
 *    include the preceding assistant messages with matching tool_use blocks.
 * 2. Thinking blocks that share the same message.id with kept assistant
 *    messages — streaming yields separate messages per content block
 *    (thinking, tool_use, text) that share one message.id.
 */
export function adjustIndexToPreservePairs(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex;
  }

  let adjusted = startIndex;

  // Step 1: Collect ALL tool_result IDs from the kept range
  const keptToolResultIds: string[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    keptToolResultIds.push(...getToolResultIds(messages[i]!));
  }

  if (keptToolResultIds.length > 0) {
    // Collect tool_use IDs already in the kept range
    const toolUseIdsInKept = new Set<string>();
    for (let i = adjusted; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIdsInKept.add(block.id);
          }
        }
      }
    }

    // Only look for tool_uses NOT already in the kept range
    const neededIds = new Set(
      keptToolResultIds.filter((id) => !toolUseIdsInKept.has(id)),
    );

    // Walk backwards to find the matching assistant messages
    for (let i = adjusted - 1; i >= 0 && neededIds.size > 0; i--) {
      const msg = messages[i]!;
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id && neededIds.has(block.id)) {
            neededIds.delete(block.id);
          }
        }
        adjusted = i;
      }
    }
  }

  // Step 2: Handle thinking blocks — collect message.ids from kept
  // assistant messages, then walk backwards for same-id peers.
  //
  // Note: Coderix's Message type currently has no explicit `id` field.
  // When streaming yields separate messages per content block, each
  // has the same ephemeral id. If the Message type gains an id field,
  // this code will begin working automatically. For now, it's a no-op
  // that becomes active when streaming-aware message grouping is added.
  const messageIdsInKept = new Set<string>();
  for (let i = adjusted; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && (msg as unknown as Record<string, unknown>).id) {
      messageIdsInKept.add((msg as unknown as Record<string, string>).id as string);
    }
  }

  if (messageIdsInKept.size > 0) {
    for (let i = adjusted - 1; i >= 0; i--) {
      const msg = messages[i]!;
      const msgId = (msg as unknown as Record<string, unknown>).id as string | undefined;
      if (
        msg.role === 'assistant' &&
        msgId &&
        messageIdsInKept.has(msgId)
      ) {
        adjusted = i;
      }
    }
  }

  return adjusted;
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

function hasTextBlocks(message: Message): boolean {
  if (typeof message.content === 'string') {
    return message.content.length > 0;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  if (message.role === 'assistant') {
    return message.content.some((b) => b.type === 'text');
  }
  if (message.role === 'user') {
    return message.content.some((b) => b.type === 'text');
  }
  return false;
}

function getToolResultIds(message: Message): string[] {
  if (message.role !== 'user' || !Array.isArray(message.content)) {
    return [];
  }
  const ids: string[] = [];
  for (const block of message.content) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
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
          COMPACTABLE_TOOLS.has(block.name)
        ) {
          ids.push(block.id!);
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

function estimateBlockTokensForResult(block: ContentBlock): number {
  if (!block.content) {
    return 0;
  }

  if (typeof block.content === 'string') {
    // Use the code rate from token-budget for tool output
    return Math.ceil(block.content.length / 2.0);
  }

  // Array of text/image blocks
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') {
      return sum + Math.ceil((item.text ?? '').length / 2.0);
    }
    if (item.type === 'image') {
      return sum + IMAGE_TOKEN_ESTIMATE;
    }
    return sum;
  }, 0);
}
