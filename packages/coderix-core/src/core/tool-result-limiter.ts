/**
 * tool-result-limiter.ts -- Tool result size limits and disk persistence
 *
 * Prevents excessively large tool results from consuming too much
 * context window space. When a result exceeds the per-tool token limit
 * (default 15K tokens), it is persisted to disk and replaced with
 * a preview + file path reference.
 *
 * Also enforces a per-message aggregate budget (default 60K tokens)
 * so that N parallel tools each hitting the per-tool max don't
 * collectively blow out the context.
 *
 * Token counting uses tiktoken (cl100k_base) when available,
 * falling back to character-based estimation.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolResultBlock } from './types.js';
import { countContentTokens, countTokens } from './token-counter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max tokens for a single tool result before persistence (~50K chars English). */
export const DEFAULT_MAX_RESULT_TOKENS = 15_000;

/** Default max chars for a single tool result before persistence (fallback). */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Max aggregate tokens for tool_results within a single user message (~200K chars English). */
export const MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS = 60_000;

/** Max aggregate characters for tool_results within a single user message (fallback). */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/** Tool results persisted to this directory. */
export const TOOL_RESULTS_DIR = join(homedir(), '.coderix', 'tool-results');

/** Tag used to identify persisted output messages. */
const PERSISTED_OUTPUT_TAG = '<persisted-output>';
const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>';

/** Preview size in characters for the reference message. */
const PREVIEW_CHARS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersistedResult {
  filepath: string;
  originalTokens: number;
  originalChars: number;
  preview: string;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply tool result size limits to a batch of results from a single turn.
 *
 * @param results - The tool result blocks to process
 * @param toolNames - Parallel array of tool names (same order as results)
 * @param maxResultTokensByTool - Optional map from tool name to its max tokens
 * @returns Processed results with large outputs replaced by previews
 */
export async function applyToolResultLimits(
  results: ToolResultBlock[],
  toolNames: string[],
  maxResultTokensByTool?: ReadonlyMap<string, number>,
): Promise<ToolResultBlock[]> {
  // Step 1: Per-result limit + empty result marker
  const withPerResultLimit = await Promise.all(
    results.map(async (result, i) => {
      const toolName = toolNames[i] ?? 'unknown';

      // Empty result marker
      if (isResultContentEmpty(result.content)) {
        return { ...result, content: `(${toolName} completed with no output)` };
      }

      // Per-tool size limit
      const maxTokens =
        maxResultTokensByTool?.get(toolName) ?? DEFAULT_MAX_RESULT_TOKENS;
      // Infinity means the tool self-bounds -- skip
      if (!Number.isFinite(maxTokens)) return result;

      return limitSingleResult(result, toolName, maxTokens);
    }),
  );

  // Step 2: Per-message aggregate budget
  return enforceAggregateBudget(withPerResultLimit, toolNames);
}

// ---------------------------------------------------------------------------
// Per-result limit
// ---------------------------------------------------------------------------

async function limitSingleResult(
  result: ToolResultBlock,
  toolName: string,
  maxTokens: number,
): Promise<ToolResultBlock> {
  const contentStr = extractContentString(result.content);
  const tokenCount = countContentTokens(result.content);

  if (tokenCount <= maxTokens) return result;

  const persisted = await persistToolResult(contentStr, result.tool_use_id, tokenCount);
  if (!persisted) return result; // persist failed -- send original

  const message = buildLargeResultMessage(persisted);
  return { ...result, content: message };
}

// ---------------------------------------------------------------------------
// Aggregate budget
// ---------------------------------------------------------------------------

async function enforceAggregateBudget(
  results: ToolResultBlock[],
  toolNames: string[],
): Promise<ToolResultBlock[]> {
  // Calculate total tokens
  const tokensPerResult = results.map((r) => countContentTokens(r.content));
  const totalTokens = tokensPerResult.reduce((sum, t) => sum + t, 0);

  if (totalTokens <= MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS) return results;

  // Collect eligible candidates (not already compacted, not empty)
  interface Candidate {
    index: number;
    toolUseId: string;
    content: string;
    tokens: number;
  }
  const candidates: Candidate[] = [];
  for (let i = 0; i < results.length; i++) {
    const content = extractContentString(results[i]!.content);
    if (isContentAlreadyCompacted(content)) continue;
    if (content.length === 0) continue;
    candidates.push({
      index: i,
      toolUseId: results[i]!.tool_use_id,
      content,
      tokens: tokensPerResult[i] ?? countTokens(content),
    });
  }

  if (candidates.length === 0) return results;

  // Sort largest first, persist until under budget
  candidates.sort((a, b) => b.tokens - a.tokens);

  let remaining = totalTokens;
  const toReplace = new Set<number>();

  for (const c of candidates) {
    if (remaining <= MAX_TOOL_RESULTS_PER_MESSAGE_TOKENS) break;
    toReplace.add(c.index);
    remaining -= c.tokens; // approximate -- replacement is much smaller
  }

  if (toReplace.size === 0) return results;

  const mapped = await Promise.all(
    results.map(async (result, i) => {
      if (!toReplace.has(i)) return result;

      const contentStr = extractContentString(result.content);
      const tokenCount = tokensPerResult[i] ?? countTokens(contentStr);
      const persisted = await persistToolResult(contentStr, result.tool_use_id, tokenCount);
      if (!persisted) return result;

      const message = buildLargeResultMessage(persisted);
      return { ...result, content: message };
    }),
  );

  return mapped;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistToolResult(
  content: string,
  toolUseId: string,
  tokenCount: number,
): Promise<PersistedResult | null> {
  try {
    await mkdir(TOOL_RESULTS_DIR, { recursive: true });

    const filepath = join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);

    // Use 'wx' flag to avoid overwriting -- idempotent across turns
    try {
      await writeFile(filepath, content, { encoding: 'utf-8', flag: 'wx' });
    } catch (err: unknown) {
      // EEXIST is fine -- already persisted on a prior turn
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }

    const { preview, hasMore } = generatePreview(content, PREVIEW_CHARS);

    return {
      filepath,
      originalTokens: tokenCount,
      originalChars: content.length,
      preview,
      hasMore,
    };
  } catch {
    // Persistence failed -- return null so caller sends original content
    return null;
  }
}

function buildLargeResultMessage(result: PersistedResult): string {
  const tokenStr = `${result.originalTokens} tokens`;
  const charStr = formatSize(result.originalChars);
  let message = `${PERSISTED_OUTPUT_TAG}\n`;
  message += `Output too large (${tokenStr}, ${charStr}). Full output saved to: ${result.filepath}\n\n`;
  message += `Preview (first ${PREVIEW_CHARS} chars):\n`;
  message += result.preview;
  message += result.hasMore ? '\n...\n' : '\n';
  message += PERSISTED_OUTPUT_CLOSING_TAG;
  return message;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractContentString(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => ('text' in b ? (b as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

function isResultContentEmpty(content: ToolResultBlock['content']): boolean {
  if (!content) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  return content.every(
    (block) =>
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      (typeof block.text !== 'string' || block.text.trim() === ''),
  );
}

function isContentAlreadyCompacted(content: string): boolean {
  return content.startsWith(PERSISTED_OUTPUT_TAG);
}

function generatePreview(
  content: string,
  maxChars: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxChars) {
    return { preview: content, hasMore: false };
  }

  // Find the last newline within the limit to avoid cutting mid-line
  const truncated = content.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');

  const cutPoint =
    lastNewline > maxChars * 0.5 ? lastNewline : maxChars;

  return { preview: content.slice(0, cutPoint), hasMore: true };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
