/**
 * session-memory-compact.ts — Zero-API-cost compaction using memory files.
 *
 * When session memory is available (from background memory extraction),
 * this strategy reuses existing memory files as a conversation summary
 * instead of calling the LLM. This is the cheapest compaction strategy
 * after microcompact.
 *
 * Ported from claude-code-best's sessionMemoryCompact.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, UserMessage } from '../types.js';
import type { CompactionResult, SessionMemoryCompactConfig } from './compact-types.js';
import {
  MIN_KEEP_TOKENS,
  MAX_KEEP_TOKENS,
  MIN_TEXT_BLOCK_MESSAGES,
  SM_COMPACT_EXIT_THRESHOLD,
} from './compact-types.js';
import { estimateMessageTokens, estimateTokens } from '../token-budget.js';
import { createCompactBoundaryMessage } from './compact-boundary.js';
import { getCompactUserSummaryMessage } from './compact-prompt.js';

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_SM_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  minTextBlockMessages: 5,
  maxTokens: 40_000,
};

// ---------------------------------------------------------------------------
// Lazy imports for memory modules
// ---------------------------------------------------------------------------

let _getMemoryDir: ((cwd: string) => string) | null = null;
let _scanMemoryFiles:
  | ((
      dir: string,
      limit: number,
      signal: AbortSignal,
    ) => Promise<
      Array<{
        filename: string;
        filePath: string;
        description: string | null;
        type: string | undefined;
      }>
    >)
  | null = null;

async function ensureMemoryImports() {
  if (!_getMemoryDir) {
    const mod = await import('../../memory/memory-directory.js');
    _getMemoryDir = mod.getMemoryDir;
  }
  if (!_scanMemoryFiles) {
    const mod = await import('../../memory/frontmatter.js');
    _scanMemoryFiles = mod.scanMemoryFiles;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try session memory compaction.
 *
 * @param cwd - Working directory, used to locate memory files.
 * @param messages - Current conversation messages.
 * @param autoCompactThreshold - If provided, checks that the post-compact
 *   token count is below this threshold. Returns null if it isn't.
 * @returns CompactionResult on success, null if SM compact is unavailable.
 */
export async function trySessionMemoryCompaction(
  cwd: string,
  messages: Message[],
  autoCompactThreshold?: number,
): Promise<CompactionResult | null> {
  await ensureMemoryImports();

  try {
    const memoryDir = _getMemoryDir!(cwd);
    if (!existsSync(memoryDir)) return null;

    const ac = new AbortController();
    const files = await _scanMemoryFiles!(memoryDir, 100, ac.signal);
    if (files.length === 0) return null;

    // Read memory file contents
    const memories: Array<{
      name: string;
      description: string;
      content: string;
    }> = [];
    for (const file of files) {
      try {
        const filePath = join(memoryDir, file.filename);
        const raw = readFileSync(filePath, 'utf-8');
        // Extract content after frontmatter (between second ---)
        const parts = raw.split('---');
        const body =
          parts.length >= 3 ? parts.slice(2).join('---').trim() : raw;
        memories.push({
          name: file.filename.replace(/\.md$/, ''),
          description: file.description ?? file.filename,
          content: body.slice(0, 3000), // cap per memory
        });
      } catch {
        // skip unreadable files
      }
    }

    if (memories.length === 0) return null;

    // Build summary from memory contents
    const summaryParts: string[] = [
      'This session is being continued from a previous conversation.',
      'The following context was extracted from earlier work:',
      '',
    ];

    for (const m of memories) {
      summaryParts.push(
        `## ${m.description}\n${m.content.slice(0, 2000)}`,
      );
    }

    const summaryText = summaryParts.join('\n\n');

    // Calculate messages to keep
    const keepIndex = calculateSMKeepIndex(messages, DEFAULT_SM_CONFIG);
    const messagesToKeep =
      keepIndex > 0 ? messages.slice(keepIndex) : messages;

    // Check threshold
    const preTokens = estimateTokens(messages);
    const postTokens =
      estimateTokens(messagesToKeep) +
      estimateMessageTokens({ role: 'user', content: summaryText });

    if (autoCompactThreshold !== undefined && postTokens > autoCompactThreshold) {
      return null;
    }

    // Build result
    const summaryContent = getCompactUserSummaryMessage(
      summaryText,
      true, // suppressFollowUpQuestions
    );

    const summaryMessages: UserMessage[] = [
      { role: 'user', content: summaryContent },
    ];

    const boundaryMarker = createCompactBoundaryMessage(
      'auto',
      preTokens,
      messages.length - messagesToKeep.length,
    );

    return {
      boundaryMarker,
      summaryMessages,
      attachments: [],
      hookResults: [],
      messagesToKeep,
      preCompactTokenCount: preTokens,
      postCompactTokenCount: postTokens,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Message keeping index for SM compact
// ---------------------------------------------------------------------------

/**
 * Calculate the index from which to keep messages for session memory compact.
 * Expands backwards to meet minimum token + text-block-message requirements.
 */
function calculateSMKeepIndex(
  messages: Message[],
  config: SessionMemoryCompactConfig,
): number {
  if (messages.length === 0) return 0;

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

    // Stop if we hit the max cap
    if (totalTokens >= config.maxTokens) {
      break;
    }

    // Stop if we meet both minimums
    if (
      totalTokens >= config.minTokens &&
      textBlockMsgCount >= config.minTextBlockMessages
    ) {
      break;
    }
  }

  // Adjust to preserve tool_use/tool_result pairs
  return adjustToPreservePairs(messages, startIndex);
}

// ---------------------------------------------------------------------------
// Helpers
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

function adjustToPreservePairs(
  messages: Message[],
  startIndex: number,
): number {
  if (startIndex <= 0 || startIndex >= messages.length) {
    return startIndex;
  }

  let adjusted = startIndex;

  // Collect tool_result IDs from the kept range
  const keptToolResultIds: string[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          keptToolResultIds.push(block.tool_use_id);
        }
      }
    }
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

  return adjusted;
}
