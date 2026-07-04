/**
 * Snip Compact — marker-based conversation history trimming.
 *
 * Users insert a snip marker via /snip. Before each API call, the query loop
 * drops all messages before the last marker, keeping only the post-marker
 * conversation tail. This is a zero-cost way to surgically discard stale
 * context without LLM summarization.
 */
import type { Message } from './types.js';

export const SNIP_MARKER = '__CODERIX_SNIP_MARKER__';

// ── Global request flag (mirrors requestManualCompact pattern) ────

let pendingSnip = false;

/** Request a snip marker to be injected before the next API call. */
export function requestSnip(): void {
  pendingSnip = true;
}

/** Consume the pending snip request. Returns true if a snip was requested. */
export function consumeSnipRequest(): boolean {
  if (pendingSnip) {
    pendingSnip = false;
    return true;
  }
  return false;
}

/** Create a user message that acts as a snip boundary marker. */
export function createSnipMarker(): Message {
  return {
    role: 'user',
    content: `${SNIP_MARKER} Conversation history before this point has been snipped to save context.`,
  };
}

/** Result of a snip compact operation. */
export interface SnipCompactResult {
  messages: Message[];
  snippedCount: number;
}

/**
 * Trim messages before the last snip marker.
 *
 * If no marker is found, returns the original array unchanged.
 * When snip succeeds, the first message is guaranteed to be user-role
 * (a system preamble is prepended if needed).
 */
export function snipCompact(messages: Message[]): SnipCompactResult {
  // Find the last snip marker by scanning backwards
  let lastMarkerIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (typeof m.content === 'string' && m.content.startsWith(SNIP_MARKER)) {
      lastMarkerIndex = i;
      break;
    }
  }

  if (lastMarkerIndex === -1) {
    return { messages, snippedCount: 0 };
  }

  // Keep everything after the marker (exclusive of the marker itself)
  const kept = messages.slice(lastMarkerIndex + 1);
  const snippedCount = lastMarkerIndex + 1;

  // Ensure the first message is user-role (API requirement)
  if (kept.length > 0 && kept[0]!.role !== 'user') {
    kept.unshift({
      role: 'user',
      content: '[Snip boundary — conversation trimmed]',
    });
  }

  return { messages: kept, snippedCount };
}
