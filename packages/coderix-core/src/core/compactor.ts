/**
 * Compactor — Micro-compaction, LLM summarization, and token-aware truncation.
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
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { estimateMessageTokens } from './token-budget.js';
import { countTokens } from './token-counter.js';
import type {
  Message,
  ContentBlock,
  ToolResultBlock,
  AssistantMessage,
  UserMessage,
  StreamEvent,
} from './types.js';
import type { CompactMetadata } from './types.js';

// Lazy imports to avoid circular deps — these are only needed for
// session-memory compact and LLM summarization paths.
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
let _classifyError:
  | ((error: Error) => { category: string; retryable: boolean })
  | null = null;

async function ensureMemoryImports() {
  if (!_getMemoryDir) {
    const mod = await import('../memory/memory-directory.js');
    _getMemoryDir = mod.getMemoryDir;
  }
  if (!_scanMemoryFiles) {
    const mod = await import('../memory/frontmatter.js');
    _scanMemoryFiles = mod.scanMemoryFiles;
  }
}

async function ensureErrorImports() {
  if (!_classifyError) {
    const mod = await import('./error-recovery.js');
    _classifyError = mod.classifyError;
  }
}

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
  'WebSearch',
  'WebFetch',
  'update',
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

// ---------------------------------------------------------------------------
// Types for LLM compaction
// ---------------------------------------------------------------------------

// compactConversation uses same signature as query.ts CallModelParams.
// Avoids a circular import by not importing CallModelParams directly.
type CompactModelFn = (
  params: {
    system: string;
    messages: Message[];
    tools: unknown[];
    signal: AbortSignal;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => AsyncGenerator<StreamEvent | AssistantMessage, any, any>;

export interface LLMCompactResult {
  boundaryMarker: Message;
  summaryMessages: UserMessage[];
  messagesToKeep: Message[];
  preCompactTokens: number;
  postCompactTokens: number;
  strategy: CompactMetadata['strategy'];
}

// ---------------------------------------------------------------------------
// Public API — LLM Summarization Compact
// ---------------------------------------------------------------------------

/**
 * Generate a conversation summary via LLM and return the compacted result.
 *
 * Handles:
 * - Image stripping (images aren't needed for summarization)
 * - PTL retry (drop oldest message groups if summarization itself is too long)
 * - Summary formatting
 *
 * Caller is responsible for assembling the final message array from
 * boundaryMarker + summaryMessages + messagesToKeep.
 */
export async function compactConversation(
  messages: Message[],
  callModel: CompactModelFn,
  options: {
    signal: AbortSignal;
    preCompactTokens: number;
    model: string;
    customInstructions?: string;
  },
): Promise<LLMCompactResult> {
  let messagesToSummarize = stripImagesFromMessages(messages);
  const preCompactTokens = options.preCompactTokens;

  const summaryPrompt = buildCompactSystemPrompt(options.customInstructions);
  const summaryRequest: Array<{ role: string; content: string }> = [
    { role: 'user', content: summaryPrompt },
  ];

  // PTL retry loop
  const MAX_PTL_RETRIES = 3;
  let ptlAttempts = 0;

  for (;;) {
    const result = await callSummaryModel(
      callModel,
      summaryPrompt,
      messagesToSummarize,
      options.signal,
    );

    // Check for prompt-too-long
    const isPTL = isPromptTooLongError(result.error);
    if (!isPTL) {
      if (!result.text) {
        throw new Error(
          'Failed to generate conversation summary — empty response',
        );
      }

      // Build the compact result
      const summaryText = formatCompactSummary(result.text);
      const summaryContent = buildCompactSummaryContent(
        summaryText,
        true, // suppressFollowUpQuestions
      );

      const messagesToKeep = calculateMessagesToKeepIndex(messages);
      const keptMessages =
        messagesToKeep > 0 ? messages.slice(messagesToKeep) : [];

      const boundaryMarker: Message = {
        role: 'system',
        content: `[Compact boundary — context summarized. ${preCompactTokens} → ~${estimateMessageTokens({ role: 'user', content: summaryContent })} tokens]`,
      };

      return {
        boundaryMarker,
        summaryMessages: [{ role: 'user', content: summaryContent }],
        messagesToKeep: keptMessages,
        preCompactTokens,
        postCompactTokens:
          estimateMessageTokens({ role: 'user', content: summaryContent }) +
          keptMessages.reduce((s, m) => s + estimateMessageTokens(m), 0),
        strategy: 'summarize',
      };
    }

    // PTL: drop oldest messages
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
// Public API — Session Memory Compact
// ---------------------------------------------------------------------------

export interface SessionMemoryCompactResult {
  summaryContent: string;
  messagesToKeep: Message[];
}

/**
 * Try to build a summary from existing memory files.
 * Returns null if memory is unavailable or empty.
 *
 * This is a zero-API-cost alternative to LLM summarization —
 * it reuses the memory that was already extracted by the background
 * extraction system instead of calling the model again.
 */
export async function trySessionMemoryCompact(
  cwd: string,
): Promise<SessionMemoryCompactResult | null> {
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
    const summary = [
      'This session is being continued from a previous conversation.',
      'The following context was extracted from earlier work:',
      '',
      ...memories.map(
        (m) =>
          `## ${m.description}\n${m.content.slice(0, 2000)}`,
      ),
    ].join('\n\n');

    return {
      summaryContent: summary,
      messagesToKeep: [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM Summarization helpers
// ---------------------------------------------------------------------------

function buildCompactSystemPrompt(customInstructions?: string): string {
  let prompt = `You are summarizing a conversation between an AI coding agent and a user.
Your task is to create a detailed summary so that work can continue seamlessly.

Include these sections:
1. Primary Request and Intent: What the user asked for, in detail
2. Key Technical Concepts: Technologies, frameworks, patterns discussed
3. Files and Code: Specific files examined, modified, or created. Include code snippets.
4. Errors and Fixes: Problems encountered and how they were resolved. Include user feedback.
5. All User Messages: List every non-tool-result message from the user
6. Pending Tasks: Tasks explicitly requested but not yet completed
7. Current Work: Precisely what was being worked on immediately before this summary

Be thorough. Include file names, function signatures, and code snippets.
`;
  if (customInstructions) {
    prompt += `\nAdditional instructions: ${customInstructions}`;
  }
  return prompt;
}

async function callSummaryModel(
  callModel: CompactModelFn,
  systemPrompt: string,
  messages: Message[],
  signal: AbortSignal,
): Promise<{ text: string | null; error: Error | null }> {
  try {
    // Build context from messages — convert to simple text format
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
        fullText += (streamEvent.delta as { text: string }).text ?? '';
      }
    }

    return { text: fullText || null, error: null };
  } catch (error) {
    return { text: null, error: error as Error };
  }
}

function buildCompactContext(messages: Message[]): string {
  const parts: string[] = [];
  parts.push('Below is the conversation to summarize:\n');

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    const role = msg.role === 'assistant' ? 'ASSISTANT' : 'USER';
    if (typeof msg.content === 'string') {
      parts.push(`[${role}] ${msg.content.slice(0, 2000)}`);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push(`[${role}] ${(block.text ?? '').slice(0, 2000)}`);
        } else if (block.type === 'tool_use') {
          parts.push(
            `[${role} — used tool: ${block.name}]`,
          );
        } else if (
          block.type === 'tool_result' &&
          typeof block.content === 'string'
        ) {
          parts.push(
            `[tool result] ${block.content.slice(0, 500)}`,
          );
        }
      }
    }
  }

  return parts.join('\n');
}

function formatCompactSummary(raw: string): string {
  // Clean up common artifacts
  let text = raw
    .replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
    .replace(/<summary>|<\/summary>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function buildCompactSummaryContent(
  summary: string,
  suppressFollowUp: boolean,
): string {
  let content = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}`;

  if (suppressFollowUp) {
    content +=
      '\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly.';
  }

  return content;
}

// ---------------------------------------------------------------------------
// PTL Retry helpers
// ---------------------------------------------------------------------------

function isPromptTooLongError(error: Error | null): boolean {
  if (!error) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('prompt too long') ||
    msg.includes('context_too_large') ||
    msg.includes('too large') ||
    msg.includes('413') ||
    msg.includes('maximum context length') ||
    msg.includes('token limit')
  );
}

/**
 * Drop the oldest ~20% of message groups. Groups are delimited by
 * assistant messages (each new assistant starts a new API round).
 */
function dropOldestMessageGroups(messages: Message[]): Message[] | null {
  if (messages.length <= 2) return null;

  // Find group boundaries: a new assistant message starts a group
  const boundaries: number[] = [0];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant') {
      boundaries.push(i);
    }
  }
  boundaries.push(messages.length);

  if (boundaries.length <= 3) return null; // only 1-2 groups

  const dropGroups = Math.max(1, Math.floor((boundaries.length - 1) * 0.2));
  const cutIndex = boundaries[dropGroups] ?? boundaries[1];

  const result = messages.slice(cutIndex!);

  // Ensure first message is role=user (API requirement)
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
// Image stripping (for compact input)
// ---------------------------------------------------------------------------

function stripImagesFromMessages(messages: Message[]): Message[] {
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
