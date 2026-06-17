/**
 * tool-result-limiter.ts — Tool result size limits and disk persistence
 *
 * Prevents excessively large tool results from consuming too much
 * context window space. When a result exceeds the per-tool limit
 * (default 50K chars), it is persisted to disk and replaced with
 * a preview + file path reference.
 *
 * Also enforces a per-message aggregate budget (default 200K chars)
 * so that N parallel tools each hitting the per-tool max don't
 * collectively blow out the context.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolResultBlock } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max chars for a single tool result before persistence. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Max aggregate characters for tool_results within a single user message. */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/** Tool results persisted to this directory. */
export const TOOL_RESULTS_DIR = join(homedir(), '.ink-chat-tui', 'tool-results');

/** Tag used to identify persisted output messages. */
const PERSISTED_OUTPUT_TAG = '<persisted-output>';
const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>';

/** Preview size in characters for the reference message. */
const PREVIEW_SIZE_CHARS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersistedResult {
  filepath: string;
  originalSize: number;
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
 * @param maxResultSizeByTool - Optional map from tool name to its max size
 * @returns Processed results with large outputs replaced by previews
 */
export function applyToolResultLimits(
  results: ToolResultBlock[],
  toolNames: string[],
  maxResultSizeByTool?: ReadonlyMap<string, number>,
): ToolResultBlock[] {
  // Step 1: Per-result limit + empty result marker
  const withPerResultLimit = results.map((result, i) => {
    const toolName = toolNames[i] ?? 'unknown';

    // Empty result marker — inject placeholder so the model always
    // has something to react to at the prompt tail
    if (isResultContentEmpty(result.content)) {
      return { ...result, content: `(${toolName} completed with no output)` };
    }

    // Per-tool size limit
    const maxSize =
      maxResultSizeByTool?.get(toolName) ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
    // Infinity means the tool self-bounds — skip
    if (!Number.isFinite(maxSize)) return result;

    return limitSingleResult(result, toolName, maxSize);
  });

  // Step 2: Per-message aggregate budget
  return enforceAggregateBudget(withPerResultLimit, toolNames);
}

// ---------------------------------------------------------------------------
// Per-result limit
// ---------------------------------------------------------------------------

function limitSingleResult(
  result: ToolResultBlock,
  _toolName: string,
  maxSize: number,
): ToolResultBlock {
  const contentStr = extractContentString(result.content);
  if (contentStr.length <= maxSize) return result;

  const persisted = persistToolResult(contentStr, result.tool_use_id);
  if (!persisted) return result; // persist failed — send original

  const message = buildLargeResultMessage(persisted);
  return { ...result, content: message };
}

// ---------------------------------------------------------------------------
// Aggregate budget
// ---------------------------------------------------------------------------

function enforceAggregateBudget(
  results: ToolResultBlock[],
  toolNames: string[],
): ToolResultBlock[] {
  const totalSize = results.reduce(
    (sum, r) => sum + extractContentString(r.content).length,
    0,
  );

  if (totalSize <= MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) return results;

  // Collect eligible candidates (not already compacted, not empty)
  interface Candidate {
    index: number;
    toolUseId: string;
    content: string;
    size: number;
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
      size: content.length,
    });
  }

  if (candidates.length === 0) return results;

  // Sort largest first, persist until under budget
  candidates.sort((a, b) => b.size - a.size);

  let remaining = totalSize;
  const toReplace = new Set<number>();

  for (const c of candidates) {
    if (remaining <= MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) break;
    toReplace.add(c.index);
    remaining -= c.size; // approximate — replacement is much smaller
  }

  if (toReplace.size === 0) return results;

  return results.map((result, i) => {
    if (!toReplace.has(i)) return result;

    const contentStr = extractContentString(result.content);
    const persisted = persistToolResult(contentStr, result.tool_use_id);
    if (!persisted) return result;

    const message = buildLargeResultMessage(persisted);
    return { ...result, content: message };
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persistToolResult(
  content: string,
  toolUseId: string,
): PersistedResult | null {
  try {
    if (!existsSync(TOOL_RESULTS_DIR)) {
      mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
    }

    const filepath = join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);

    // Use 'wx' flag to avoid overwriting — idempotent across turns
    try {
      writeFileSync(filepath, content, { encoding: 'utf-8', flag: 'wx' });
    } catch (err: unknown) {
      // EEXIST is fine — already persisted on a prior turn
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }

    const { preview, hasMore } = generatePreview(content, PREVIEW_SIZE_CHARS);

    return {
      filepath,
      originalSize: content.length,
      preview,
      hasMore,
    };
  } catch {
    // Persistence failed — return null so caller sends original content
    return null;
  }
}

function buildLargeResultMessage(result: PersistedResult): string {
  const sizeStr = formatSize(result.originalSize);
  const previewSizeStr = formatSize(PREVIEW_SIZE_CHARS);
  let message = `${PERSISTED_OUTPUT_TAG}\n`;
  message += `Output too large (${sizeStr}). Full output saved to: ${result.filepath}\n\n`;
  message += `Preview (first ${previewSizeStr}):\n`;
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
