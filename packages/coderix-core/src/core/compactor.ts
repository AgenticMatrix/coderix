/**
 * Compactor — Multi-strategy context compression orchestration.
 *
 * Strategies, ordered by cost (cheapest first):
 *
 * 1. Time-Based Micro Compact — clear old tool results when server cache expired
 * 2. Session Memory Compact — use existing memory files as summary (zero API cost)
 * 3. LLM Summarization — call model to generate conversation summary
 * 4. Token-Aware Truncation — last resort, drop oldest messages
 *
 * Each strategy is tried in order; if one brings context under threshold,
 * subsequent strategies are skipped.
 *
 * This module is the orchestration layer — implementation details are
 * delegated to sub-modules under compact/.
 */

import type { Message, ContentBlock, ToolResultBlock, AssistantMessage, UserMessage, StreamEvent } from './types.js';
import type { CompactMetadata } from './types.js';
import { estimateMessageTokens } from './token-budget.js';
import { countTokens } from './token-counter.js';

// Import from sub-modules
import { microcompactMessages } from './compact/microcompact.js';
import {
  getCompactPrompt,
  formatCompactSummary,
  getCompactUserSummaryMessage,
  buildCompactContext,
} from './compact/compact-prompt.js';
import {
  createCompactBoundaryMessage,
  stripImagesFromMessages,
  dropOldestMessageGroups,
  buildPostCompactMessages,
} from './compact/compact-boundary.js';
import { trySessionMemoryCompaction } from './compact/session-memory-compact.js';
import { isPromptTooLongError } from './compact/reactive-compact.js';
import type { CompactionResult } from './compact/compact-types.js';
import {
  MIN_KEEP_TOKENS,
  MAX_KEEP_TOKENS,
  MIN_TEXT_BLOCK_MESSAGES,
} from './compact/compact-types.js';

// Re-export types for backward compatibility
export type {
  CompactorConfig,
  MicrocompactResult,
  TruncationResult,
  LLMCompactResult,
} from './compact/compact-types.js';

// SessionMemoryCompactResult kept for backward compat
export interface SessionMemoryCompactResult {
  summaryContent: string;
  messagesToKeep: Message[];
}

export type { CompactionResult };

// ---------------------------------------------------------------------------
// Manual compact flag — set by /compact command, consumed by query loop
// ---------------------------------------------------------------------------

let _manualCompactRequested = false;

/** Signal that a manual /compact was requested by the user. */
export function requestManualCompact(): void {
  _manualCompactRequested = true;
}

/** Consume the manual compact flag. Returns true if compaction was requested. */
export function consumeManualCompactRequest(): boolean {
  const was = _manualCompactRequested;
  _manualCompactRequested = false;
  return was;
}

// ---------------------------------------------------------------------------
// Compactor class
// ---------------------------------------------------------------------------

/**
 * Compactor — orchestrates micro-compaction strategies.
 *
 * The class wraps microcompactMessages() from the microcompact module.
 * For LLM summarization and session memory compact, use the standalone
 * functions compactConversation() and trySessionMemoryCompact().
 */
export class Compactor {
  private config: { estimateTokens: (messages: Message[]) => number; summarizeEnabled: boolean };

  constructor(config: { estimateTokens: (messages: Message[]) => number; summarizeEnabled: boolean }) {
    this.config = config;
  }

  /**
   * Apply micro-compaction strategies to shrink context before an API call.
   *
   * Delegates to the microcompact module.
   */
  async microcompact(
    messages: Message[],
    lastUserInteractionTime?: number,
  ) {
    return microcompactMessages(messages, lastUserInteractionTime);
  }
}

// ---------------------------------------------------------------------------
// LLM Summarization Compact
// ---------------------------------------------------------------------------

/** Signature matching query.ts CallModelParams to avoid circular imports. */
type CompactModelFn = (
  params: {
    system: string;
    messages: Message[];
    tools: unknown[];
    signal: AbortSignal;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => AsyncGenerator<StreamEvent | AssistantMessage, any, any>;

/**
 * Generate a conversation summary via LLM and return the compacted result.
 *
 * Full pipeline:
 * 1. Strip images (not needed for summarization)
 * 2. Build the compact prompt (9-section template)
 * 3. PTL retry loop (up to 3 retries, drops ~20% of oldest groups each time)
 * 4. Format summary (strip <analysis> block)
 * 5. Calculate kept messages index
 * 6. Build boundary marker + summary messages
 * 7. Return CompactionResult for post-compact assembly
 */
export async function compactConversation(
  messages: Message[],
  callModel: CompactModelFn,
  options: {
    signal: AbortSignal;
    preCompactTokens: number;
    model: string;
    customInstructions?: string;
    /** Callback for streaming text deltas during LLM summarization. */
    onTextDelta?: (text: string) => void;
    /** Path to the archived transcript for post-compact reference. */
    transcriptPath?: string;
  },
): Promise<CompactionResult> {
  let messagesToSummarize = stripImagesFromMessages(messages);
  const preCompactTokens = options.preCompactTokens;

  const summaryPrompt = getCompactPrompt(options.customInstructions);

  // PTL retry loop
  const MAX_PTL_RETRIES = 3;
  let ptlAttempts = 0;

  for (;;) {
    const result = await callSummaryModel(
      callModel,
      summaryPrompt,
      messagesToSummarize,
      options.signal,
      options.onTextDelta,
    );

    const isPTL = result.error ? isPromptTooLongError(result.error) : false;
    if (!isPTL) {
      if (!result.text) {
        throw new Error(
          'Failed to generate conversation summary — empty response',
        );
      }

      // Format the summary
      const summaryText = formatCompactSummary(result.text);
      const summaryContent = getCompactUserSummaryMessage(
        summaryText,
        true, // suppressFollowUpQuestions
        options.transcriptPath,
      );

      // Full compact: do NOT keep any old messages. The summary replaces
      // all prior conversation context. Only partial compacts preserve a tail.
      const keptMessages: Message[] = [];

      // Build boundary marker
      const boundaryMarker = createCompactBoundaryMessage(
        'auto',
        preCompactTokens,
        messages.length,
      );

      // Build summary messages
      const summaryMessages: UserMessage[] = [
        { role: 'user', content: summaryContent },
      ];

      // Calculate post-compact tokens
      const postCompactTokens =
        estimateMessageTokens({ role: 'user', content: summaryContent });

      return {
        boundaryMarker,
        summaryMessages,
        attachments: [],
        hookResults: [],
        messagesToKeep: keptMessages,
        preCompactTokenCount: preCompactTokens,
        postCompactTokenCount: postCompactTokens,
      };
    }

    // PTL: drop oldest message groups
    ptlAttempts++;
    if (ptlAttempts > MAX_PTL_RETRIES) {
      throw new Error(
        'Compaction failed — summarization request too large after retries',
      );
    }

    const truncated = dropOldestMessageGroups(messagesToSummarize);
    if (!truncated) {
      throw new Error(
        'Compaction failed — cannot reduce summarization input further',
      );
    }
    messagesToSummarize = truncated;
  }
}

// ---------------------------------------------------------------------------
// Session Memory Compact (delegated)
// ---------------------------------------------------------------------------

/**
 * Try session memory compaction — reuses existing memory files as summary
 * instead of calling the LLM. Zero API cost.
 *
 * Delegates to the session-memory-compact module.
 */
export async function trySessionMemoryCompact(
  cwd: string,
): Promise<{ summaryContent: string; messagesToKeep: Message[] } | null> {
  const result = await trySessionMemoryCompaction(cwd, []);
  if (!result) return null;

  return {
    summaryContent: result.summaryMessages[0]?.content as string ?? '',
    messagesToKeep: result.messagesToKeep ?? [],
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
 */
export function calculateMessagesToKeepIndex(messages: Message[]): number {
  if (messages.length === 0) {
    return 0;
  }

  let startIndex = messages.length;
  let totalTokens = 0;
  let textBlockMsgCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    totalTokens += estimateMessageTokens(msg);
    if (hasTextBlocks(msg)) {
      textBlockMsgCount++;
    }
    startIndex = i;

    if (totalTokens >= MAX_KEEP_TOKENS) {
      break;
    }

    if (
      totalTokens >= MIN_KEEP_TOKENS &&
      textBlockMsgCount >= MIN_TEXT_BLOCK_MESSAGES
    ) {
      break;
    }
  }

  return adjustIndexToPreservePairs(messages, startIndex);
}

/**
 * Adjust the start index to ensure we don't split:
 * 1. tool_use/tool_result pairs
 * 2. Thinking blocks that share the same message.id
 */
export function adjustIndexToPreservePairs(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex;
  }

  let adjusted = startIndex;

  // Step 1: Collect tool_result IDs from the kept range
  const keptToolResultIds: string[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    keptToolResultIds.push(...getToolResultIds(messages[i]!));
  }

  if (keptToolResultIds.length > 0) {
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

    const neededIds = new Set(
      keptToolResultIds.filter((id) => !toolUseIdsInKept.has(id)),
    );

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

  // Step 2: Handle thinking blocks sharing the same message.id
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
// LLM Summarization helpers
// ---------------------------------------------------------------------------

async function callSummaryModel(
  callModel: CompactModelFn,
  systemPrompt: string,
  messages: Message[],
  signal: AbortSignal,
  onTextDelta?: (text: string) => void,
): Promise<{ text: string | null; error: Error | null }> {
  try {
    const contextText = buildCompactContext(messages);

    const gen = callModel({
      system: systemPrompt,
      messages: [{ role: 'user' as const, content: contextText }],
      tools: [],
      signal,
    });

    let fullText = '';
    for await (const event of gen) {
      // Handle AssistantMessage directly
      if ('role' in event && event.role === 'assistant') {
        const assistantEvent = event as AssistantMessage;
        if (Array.isArray(assistantEvent.content)) {
          for (const block of assistantEvent.content) {
            if (block.type === 'text') {
              fullText += block.text ?? '';
            }
          }
        } else if (typeof assistantEvent.content === 'string') {
          fullText += assistantEvent.content;
        }
        continue;
      }

      // Handle stream events
      const streamEvent = event as StreamEvent;
      if (
        streamEvent.type === 'content_block_delta' &&
        streamEvent.delta?.type === 'text_delta'
      ) {
        const text = (streamEvent.delta as { text: string }).text ?? '';
        fullText += text;
        onTextDelta?.(text);
      }
    }

    return { text: fullText || null, error: null };
  } catch (error) {
    return { text: null, error: error as Error };
  }
}

// ---------------------------------------------------------------------------
// Helpers — Message inspection
// ---------------------------------------------------------------------------

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
