/**
 * reactive-compact.ts — Emergency compaction on API prompt-too-long errors.
 *
 * When the API returns a 413 / prompt-too-long error, the normal proactive
 * compaction missed the threshold. This module provides an emergency path
 * that runs compaction inline — it MUST succeed for the conversation to
 * continue.
 */

import type { CompactionResult } from './compact-types.js';
import type { Message } from '../types.js';
import type { AssistantMessage, StreamEvent } from '../types.js';

/** Signature matching query.ts CallModelParams to avoid circular imports. */
type CallModelFn = (
  params: {
    system: string;
    messages: Message[];
    tools: unknown[];
    signal: AbortSignal;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => AsyncGenerator<StreamEvent | AssistantMessage, any, any>;

/**
 * Run emergency compaction on a prompt-too-long conversation.
 *
 * This is a thin wrapper around compactConversation with `isAutoCompact: true`.
 * Returns { ok: true, result } on success or { ok: false, reason } on failure.
 */
export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  callModel: CallModelFn,
  options: {
    signal: AbortSignal;
    customInstructions?: string;
  },
): Promise<{ ok: boolean; reason?: string; result?: CompactionResult }> {
  // Lazy-import to avoid circular deps
  const { compactConversation } = await import('../compactor.js');

  try {
    const result = await compactConversation(messages, callModel, {
      signal: options.signal,
      preCompactTokens: 0, // will be recalculated inside
      model: 'default',
      customInstructions: options.customInstructions,
    });

    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Try reactive compact in the query loop catch block.
 * Returns the compaction result or null if conditions aren't met.
 *
 * Guards:
 * - Only attempts once per error (hasAttempted flag)
 * - Won't attempt if the query was aborted
 */
export async function tryReactiveCompact(params: {
  hasAttempted: boolean;
  aborted: boolean;
  messages: Message[];
  callModel: CallModelFn;
  signal: AbortSignal;
}): Promise<CompactionResult | null> {
  if (params.hasAttempted || params.aborted) {
    return null;
  }

  const { ok, result } = await reactiveCompactOnPromptTooLong(
    params.messages,
    params.callModel,
    { signal: params.signal },
  );

  if (!ok || !result) {
    return null;
  }

  return result;
}

/**
 * Check if an error is likely a prompt-too-long / context overflow error.
 */
export function isPromptTooLongError(error: Error): boolean {
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
