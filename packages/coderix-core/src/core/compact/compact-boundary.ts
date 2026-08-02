/**
 * compact-boundary.ts — Compact boundary message creation and detection.
 *
 * Provides utilities for:
 * - Creating compact boundary markers (full and microcompact)
 * - Detecting compact boundary messages in message arrays
 * - Slicing message arrays at the last compact boundary
 */

import type { Message, ContentBlock, ToolResultBlock } from '../types.js';
import type {
  CompactBoundaryMessage,
  CompactBoundaryMetadata,
  MicrocompactBoundaryMessage,
  MicrocompactBoundaryMetadata,
} from './compact-types.js';

// ---------------------------------------------------------------------------
// Full compact boundary
// ---------------------------------------------------------------------------

/**
 * Create a compact boundary system message that marks where compaction occurred.
 * This is inserted at the start of the post-compact message array so the model
 * and the transcript renderer know context was summarized.
 */
export function createCompactBoundaryMessage(
  trigger: 'manual' | 'auto',
  preTokens: number,
  messagesSummarized?: number,
  userContext?: string,
): CompactBoundaryMessage {
  const metadata: CompactBoundaryMetadata = {
    trigger,
    preTokens,
    strategy: 'summarize',
    messagesSummarized,
    userContext,
  };

  return {
    role: 'system',
    content: '',
    subtype: 'compact_boundary',
    compactMetadata: metadata,
  } as CompactBoundaryMessage;
}

// ---------------------------------------------------------------------------
// Microcompact boundary
// ---------------------------------------------------------------------------

/**
 * Create a microcompact boundary message indicating tool results were cleared.
 */
export function createMicrocompactBoundaryMessage(
  preTokens: number,
  tokensSaved: number,
  compactedToolIds: string[],
): MicrocompactBoundaryMessage {
  const metadata: MicrocompactBoundaryMetadata = {
    trigger: 'auto',
    preTokens,
    tokensSaved,
    compactedToolIds,
  };

  return {
    role: 'system',
    content: 'Context microcompacted',
    subtype: 'microcompact_boundary',
    microcompactMetadata: metadata,
  } as MicrocompactBoundaryMessage;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if a message is a compact boundary marker.
 */
export function isCompactBoundaryMessage(
  message: Message,
): message is CompactBoundaryMessage {
  return (
    (message as CompactBoundaryMessage).role === 'system' &&
    (message as CompactBoundaryMessage).subtype === 'compact_boundary'
  );
}

/**
 * Check if a message is a microcompact boundary marker.
 */
export function isMicrocompactBoundaryMessage(
  message: Message,
): message is MicrocompactBoundaryMessage {
  return (
    (message as MicrocompactBoundaryMessage).role === 'system' &&
    (message as MicrocompactBoundaryMessage).subtype === 'microcompact_boundary'
  );
}

/**
 * Check if a message is any type of compact boundary.
 */
export function isAnyCompactBoundaryMessage(message: Message): boolean {
  return (
    isCompactBoundaryMessage(message) ||
    isMicrocompactBoundaryMessage(message)
  );
}

/**
 * Find the index of the last compact boundary in a message array.
 * Returns -1 if no boundary is found.
 */
export function findLastCompactBoundaryIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundaryMessage(messages[i]!)) {
      return i;
    }
  }
  return -1;
}

/**
 * Get only the messages after the last compact boundary.
 * If no boundary exists, returns all messages.
 */
export function getMessagesAfterCompactBoundary(
  messages: Message[],
): Message[] {
  const lastBoundary = findLastCompactBoundaryIndex(messages);
  if (lastBoundary === -1) {
    return messages;
  }
  return messages.slice(lastBoundary);
}

// ---------------------------------------------------------------------------
// Message stripping helpers
// ---------------------------------------------------------------------------

/**
 * Strip images and documents from messages — they're not needed for
 * summarization and would waste tokens in the compaction prompt.
 */
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const content = message.content;
    if (typeof content === 'string') return message;
    if (!Array.isArray(content)) return message;

    let hasImage = false;
    const newContent = content.flatMap((block) => {
      if (block.type === 'image') {
        hasImage = true;
        return [{ type: 'text' as const, text: '[image]' }];
      }
      return [block];
    });

    if (!hasImage) return message;
    return { ...message, content: newContent } as Message;
  });
}

/**
 * Strip compact boundaries from kept messages to avoid duplicate
 * boundary markers in the post-compact message array.
 */
export function stripCompactBoundaries(messages: Message[]): Message[] {
  return messages.filter((m) => !isAnyCompactBoundaryMessage(m));
}

// ---------------------------------------------------------------------------
// PTL retry: message grouping
// ---------------------------------------------------------------------------

/**
 * Group messages by API round. A new API round starts with each assistant
 * message (each new assistant + following user messages form one round).
 *
 * Returns array of message groups, each group being a contiguous slice.
 */
export function groupMessagesByApiRound(
  messages: Message[],
): Array<{ start: number; end: number }> {
  const groups: Array<{ start: number; end: number }> = [];

  let groupStart = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    // A new assistant message starts a new group (except the very first)
    if (msg.role === 'assistant' && i > 0) {
      groups.push({ start: groupStart, end: i });
      groupStart = i;
    }
  }

  // Last group
  if (groupStart < messages.length) {
    groups.push({ start: groupStart, end: messages.length });
  }

  return groups;
}

/**
 * Drop the oldest ~20% of message groups for PTL retry.
 * Returns null if the messages can't be reduced further.
 */
export function dropOldestMessageGroups(
  messages: Message[],
): Message[] | null {
  const groups = groupMessagesByApiRound(messages);
  if (groups.length <= 2) return null;

  const dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  const cutIndex = groups[dropCount]?.start ?? groups[1]!.start;

  const result = messages.slice(cutIndex);

  // Ensure the first remaining message is role=user (API requirement)
  if (result.length > 0 && result[0]?.role === 'assistant') {
    return [
      {
        role: 'user' as const,
        content: '[earlier context truncated for compaction]',
      },
      ...result,
    ];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Post-compact message assembly
// ---------------------------------------------------------------------------

/**
 * Strip tool_use blocks from kept messages after compaction — the model
 * should not reference tool_use blocks from the pre-compact state.
 *
 * Tool results are preserved so the model can see any recent outputs.
 */
export function stripToolUseResultsFromKept(
  messages: Message[],
): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      return message;
    }

    const filtered = message.content.filter(
      (block) => block.type !== 'tool_result',
    );

    if (filtered.length === message.content.length) {
      return message;
    }

    return { ...message, content: filtered } as Message;
  });
}

/**
 * Build the complete post-compact message array:
 * [boundary, ...summaryMessages, ...keptMessages, ...attachments, ...hookResults]
 */
export function buildPostCompactMessages(
  boundaryMarker: Message,
  summaryMessages: Message[],
  keptMessages: Message[],
  attachments: Message[] = [],
  hookResults: Message[] = [],
): Message[] {
  return [
    boundaryMarker,
    ...summaryMessages,
    ...keptMessages,
    ...attachments,
    ...hookResults,
  ];
}
