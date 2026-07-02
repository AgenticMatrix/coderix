/**
 * message-normalizer.ts — API-bound message normalization pipeline
 *
 * Normalizes messages before they are sent to the LLM API. Handles:
 *   1. Consecutive user message merging (Bedrock compatibility)
 *   2. tool_result block hoisting (API requires tool_results first)
 *   3. Text sibling folding into tool_result.content (prevents model
 *      stop-sequence bug where trailing text after tool_result renders
 *      as \n\nHuman: on the wire)
 *   4. tool_use/tool_result pairing repair (orphan removal + synthetic
 *      placeholder injection for missing results)
 *   5. Empty message filtering
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Duck-typed block interface — only the `type` field is required.
 * This lets the normalizer work with both core/types.ts ContentBlock
 * and provider/types.ts ProviderContentBlock (they differ only in
 * ImageSource.type: 'base64' vs 'base64' | 'url').
 */
interface BlockLike {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | BlockLike[];
  is_error?: boolean;
  thinking?: string;
}

interface MessageLike {
  role: string;
  content: string | BlockLike[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Placeholder injected when a tool_use has no matching tool_result. */
export const MISSING_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize messages for API submission.
 *
 * Applies the full pipeline in order:
 *   merge → pair → hoist → smoosh → filter
 *
 * Pair repair runs before hoist/smoosh so orphaned tool_results can
 * be stripped while their text siblings are still separate blocks.
 * The pipeline is idempotent — running it twice produces the same result.
 * Accepts any message-like type — blocks are duck-typed (checked by their
 * `type` field), so both core/types.ts ContentBlock and provider/types.ts
 * ProviderContentBlock are supported.
 */
export function normalizeMessagesForAPI<T extends MessageLike>(messages: T[]): T[] {
  // Filter out system messages — they are handled separately by the provider
  let result: T[] = messages.filter((m) => m.role !== 'system');

  // Step 1: Merge consecutive user messages
  result = mergeConsecutiveUserMessages(result) as T[];

  // Step 2: Repair tool_use/tool_result pairing (before smoosh so that
  // orphaned tool_results are stripped while text siblings are still separate)
  result = ensureToolResultPairing(result) as T[];

  // Step 3: Hoist tool_results to front of each user message
  result = result.map((m) => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      return { ...m, content: hoistToolResults(m.content as BlockLike[]) as BlockLike[] };
    }
    return m;
  }) as T[];

  // Step 4: Smoosh text siblings into tool_result.content
  result = result.map((m) => {
    if (m.role === 'user' && Array.isArray(m.content)) {
      return { ...m, content: smooshTextIntoToolResult(m.content as BlockLike[]) };
    }
    return m;
  }) as T[];

  // Step 4: Repair tool_use/tool_result pairing
  result = ensureToolResultPairing(result) as T[];

  // Step 5: Filter empty messages
  result = result.filter((m) => {
    if (typeof m.content === 'string') return m.content.trim().length > 0;
    if (Array.isArray(m.content)) return m.content.length > 0;
    return true;
  }) as T[];

  return result;
}

// ---------------------------------------------------------------------------
// mergeConsecutiveUserMessages
// ---------------------------------------------------------------------------

/**
 * Merge consecutive user messages into one. Required for Bedrock API
 * compatibility (does not allow consecutive user messages in a row).
 */
function mergeConsecutiveUserMessages<T extends MessageLike>(messages: T[]): T[] {
  const result: T[] = [];

  for (const msg of messages) {
    const prev = result[result.length - 1];

    if (prev && prev.role === 'user' && msg.role === 'user') {
      const prevBlocks = normalizeToBlocks(prev.content);
      const currBlocks = normalizeToBlocks(msg.content);
      result[result.length - 1] = {
        ...prev,
        content: mergeUserContent(prevBlocks, currBlocks),
      };
    } else {
      result.push(msg);
    }
  }

  return result;
}

function normalizeToBlocks(content: string | BlockLike[]): BlockLike[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  return content;
}

function mergeUserContent(a: BlockLike[], b: BlockLike[]): BlockLike[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;

  const lastA = a[a.length - 1]!;

  // If the last block is a tool_result, smoosh b's non-tool_result blocks into it
  if (lastA.type === 'tool_result') {
    const nonTR = b.filter((block) => block.type !== 'tool_result');
    const trBlocks = b.filter((block) => block.type === 'tool_result');

    if (nonTR.length > 0) {
      const smooshed = smooshIntoToolResult(lastA, nonTR);
      return [...a.slice(0, -1), smooshed, ...trBlocks];
    }
    return [...a, ...b];
  }

  // Add newline between consecutive text blocks to prevent word-joining
  const firstB = b[0];
  if (lastA.type === 'text' && firstB && firstB.type === 'text') {
    return [
      ...a.slice(0, -1),
      { type: 'text', text: (lastA.text ?? '') + '\n' },
      ...b,
    ];
  }

  return [...a, ...b];
}

// ---------------------------------------------------------------------------
// hoistToolResults
// ---------------------------------------------------------------------------

/**
 * Move all tool_result blocks to the front of the content array.
 * The Anthropic API requires tool_result blocks to come before any
 * other content blocks in a user message.
 */
function hoistToolResults(content: BlockLike[]): BlockLike[] {
  const toolResults: BlockLike[] = [];
  const otherBlocks: BlockLike[] = [];

  for (const block of content) {
    if (block.type === 'tool_result') {
      toolResults.push(block);
    } else {
      otherBlocks.push(block);
    }
  }

  return [...toolResults, ...otherBlocks];
}

// ---------------------------------------------------------------------------
// smooshTextIntoToolResult
// ---------------------------------------------------------------------------

/**
 * Fold text siblings into the last tool_result's content field.
 * Prevents the Anthropic API from rendering a stray `\n\nHuman:` turn
 * boundary after tool results, which teaches the model to emit stop
 * sequences prematurely at bare tail positions.
 */
function smooshTextIntoToolResult(content: BlockLike[]): BlockLike[] {
  const toolResults: BlockLike[] = [];
  const texts: BlockLike[] = [];
  const others: BlockLike[] = [];

  for (const block of content) {
    if (block.type === 'tool_result') {
      toolResults.push(block);
    } else if (block.type === 'text') {
      texts.push(block);
    } else {
      others.push(block);
    }
  }

  const smooshables = [...texts, ...others];
  if (toolResults.length === 0 || smooshables.length === 0) {
    return content;
  }

  // Fold into the LAST tool_result (positionally adjacent in the rendered prompt)
  const lastTR = toolResults[toolResults.length - 1]!;
  const smooshed = smooshIntoToolResult(lastTR, smooshables);

  const otherTRs = toolResults.slice(0, -1);
  return [...otherTRs, smooshed];
}

/**
 * Fold content blocks into a tool_result's content.
 */
function smooshIntoToolResult(tr: BlockLike, blocks: BlockLike[]): BlockLike {
  if (blocks.length === 0) return tr;

  // API constraint: is_error tool_results must contain only text
  const filteredBlocks = tr.is_error
    ? blocks.filter((b) => b.type === 'text')
    : blocks;
  if (filteredBlocks.length === 0) return tr;

  const allText = filteredBlocks.every((b) => b.type === 'text');
  const existing = tr.content;

  // String path — common case
  if (allText && (existing === undefined || typeof existing === 'string')) {
    const parts: string[] = [];
    if (typeof existing === 'string' && existing.trim()) {
      parts.push(existing.trim());
    }
    for (const b of filteredBlocks) {
      if (b.type === 'text' && b.text?.trim()) {
        parts.push(b.text.trim());
      }
    }
    return { ...tr, content: parts.join('\n\n') };
  }

  // Array path — normalize, concat, merge adjacent text
  const base: BlockLike[] =
    existing === undefined
      ? []
      : typeof existing === 'string'
        ? existing.trim()
          ? [{ type: 'text', text: existing.trim() }]
          : []
        : Array.isArray(existing)
          ? [...(existing as BlockLike[])]
          : [];

  const merged: BlockLike[] = [];
  for (const b of [...base, ...filteredBlocks]) {
    if (b.type === 'text') {
      const t = b.text?.trim() ?? '';
      if (!t) continue;
      const prev = merged[merged.length - 1];
      if (prev && prev.type === 'text') {
        merged[merged.length - 1] = {
          type: 'text',
          text: (prev.text ?? '') + '\n\n' + t,
        };
      } else {
        merged.push({ type: 'text', text: t });
      }
    } else {
      merged.push(b);
    }
  }

  return { ...tr, content: merged };
}

// ---------------------------------------------------------------------------
// ensureToolResultPairing
// ---------------------------------------------------------------------------

/**
 * Repair tool_use/tool_result pairing mismatches.
 *
 * Handles session resume cases where tool_use blocks may be missing
 * their corresponding tool_result blocks (or vice versa).
 *
 * Repairs:
 *   - Strips orphaned tool_results (no matching tool_use)
 *   - Injects synthetic error placeholders for missing tool_results
 *   - Deduplicates tool_use IDs
 */
function ensureToolResultPairing<T extends MessageLike>(messages: T[]): T[] {
  const result: T[] = [];
  const allSeenToolUseIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role !== 'assistant') {
      // User message without preceding assistant — check for orphaned tool_results
      if (
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        result[result.length - 1]?.role !== 'assistant'
      ) {
        const stripped = (msg.content as BlockLike[]).filter(
          (block) => block.type !== 'tool_result',
        );
        if (stripped.length !== (msg.content as BlockLike[]).length) {
          if (stripped.length > 0) {
            result.push({ ...msg, content: stripped } as T);
          } else if (result.length === 0) {
            result.push({ role: 'user', content: '[Orphaned tool result removed]' } as T);
          }
          continue;
        }
      }
      result.push(msg);
      continue;
    }

    // === Assistant message ===
    const assistantContent: BlockLike[] = Array.isArray(msg.content) ? msg.content as BlockLike[] : [];

    // If no tool_use blocks, push as-is and continue
    const hasToolUses = assistantContent.some((b) => b.type === 'tool_use');
    if (!hasToolUses) {
      result.push(msg);
      continue;
    }

    const toolUseIds: string[] = [];
    const seenInThis = new Set<string>();

    const dedupedContent = assistantContent.filter((block) => {
      if (block.type === 'tool_use' && block.id) {
        if (allSeenToolUseIds.has(block.id) || seenInThis.has(block.id)) {
          return false;
        }
        allSeenToolUseIds.add(block.id);
        seenInThis.add(block.id);
        toolUseIds.push(block.id);
      }
      return true;
    });

    result.push({ ...msg, content: dedupedContent } as T);

    // Check next message for matching tool_results
    const nextMsg = messages[i + 1];
    const existingResultIds = new Set<string>();
    let hasDuplicates = false;

    if (nextMsg?.role === 'user' && Array.isArray(nextMsg.content)) {
      for (const block of nextMsg.content as BlockLike[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          if (existingResultIds.has(block.tool_use_id)) {
            hasDuplicates = true;
          }
          existingResultIds.add(block.tool_use_id);
        }
      }
    }

    const toolUseIdSet = new Set(toolUseIds);
    const missingIds = toolUseIds.filter((id) => !existingResultIds.has(id));
    const orphanedIds = [...existingResultIds].filter((id) => !toolUseIdSet.has(id));

    if (missingIds.length === 0 && orphanedIds.length === 0 && !hasDuplicates) {
      continue;
    }

    // Synthetic error results for missing IDs
    const syntheticBlocks: BlockLike[] = missingIds.map((id) => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: MISSING_TOOL_RESULT_PLACEHOLDER,
      is_error: true,
    }));

    if (nextMsg?.role === 'user') {
      let nextContent: BlockLike[] = Array.isArray(nextMsg.content)
        ? [...(nextMsg.content as BlockLike[])]
        : typeof nextMsg.content === 'string'
          ? [{ type: 'text', text: nextMsg.content }]
          : [];

      if (orphanedIds.length > 0 || hasDuplicates) {
        const orphanedSet = new Set(orphanedIds);
        const seenTrIds = new Set<string>();
        nextContent = nextContent.filter((block) => {
          if (block.type === 'tool_result' && block.tool_use_id) {
            if (orphanedSet.has(block.tool_use_id)) return false;
            if (seenTrIds.has(block.tool_use_id)) return false;
            seenTrIds.add(block.tool_use_id);
          }
          return true;
        });
      }

      const patchedContent = [...syntheticBlocks, ...nextContent];
      if (patchedContent.length > 0) {
        result.push({ role: 'user', content: patchedContent } as T);
      }
      i++;
    } else if (syntheticBlocks.length > 0) {
      result.push({ role: 'user', content: syntheticBlocks } as T);
    }
  }

  return result;
}
