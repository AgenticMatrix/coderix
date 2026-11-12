import type { ChatMessage } from '../../store/types';
import type { StreamBlock } from '../../types';

/**
 * Convert one page of core `Message[]` (what the transcript store persists and
 * `session:load` / `session:history` return) into renderer `ChatMessage[]`.
 *
 * The transcript carries turns as separate messages: an assistant message
 * holds its `tool_use` blocks, and the matching `tool_result` blocks arrive on
 * the *following* user message. The UI renders a result inside the tool card
 * that produced it, so this pairs them and drops the now-empty carrier
 * messages.
 *
 * Paging keeps a turn's assistant message and its tool results in the same
 * page (the main process aligns every page to a user-turn boundary), so a pair
 * is never split across two calls. A pair that is nonetheless orphaned stays
 * as a standalone block rather than vanishing.
 */

/**
 * Strip the Claude Code SDK's continuation/auto-compact wrapper from a user
 * message string. When a session is resumed, the SDK prepends a summary of the
 * earlier conversation ending with a "[Latest message]" line; only that final
 * line is the text the user actually typed.
 */
export function stripCompactWrapper(content: string): string {
  const marker = '[Latest message]';
  const idx = content.lastIndexOf(marker);
  if (idx < 0) return content;
  const after = content.slice(idx + marker.length).trim();
  return after || content;
}

/** Normalize one persisted content block to the renderer's `StreamBlock`. */
function toStreamBlock(b: Record<string, unknown>): StreamBlock {
  // Image blocks carry a `source` (not `text`); flattening them through the
  // generic content fallback would erase the payload.
  if (b.type === 'image') {
    const source = b.source as { media_type?: unknown; data?: unknown } | undefined;
    return {
      type: 'image',
      content: typeof b.name === 'string' ? b.name : '',
      state: 'done',
      ...(source?.data
        ? { image: { mediaType: String(source.media_type ?? 'image/png'), data: String(source.data) } }
        : {}),
    };
  }

  // Backend blocks use `text` for text, `thinking` for reasoning, and `content`
  // for tool results. A tool result's `content` may be an array of text blocks
  // — flatten it so the tool card always receives plain text.
  let content: unknown = b.text ?? b.thinking ?? b.content ?? '';
  if (Array.isArray(content)) {
    content = content.map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? ''))).join('\n');
  }

  return {
    type: (b.type as StreamBlock['type']) || 'text',
    content: typeof content === 'string' ? content : '',
    state: b.is_error ? 'error' : 'done',
    ...(b.tool_use_id ? { toolId: b.tool_use_id as string } : {}),
    ...(b.id ? { toolId: b.id as string } : {}),
    ...(b.name ? { toolName: b.name as string } : {}),
    ...(b.input ? { toolInput: b.input as Record<string, unknown> } : {}),
    ...(b.metadata ? { toolMetadata: b.metadata as Record<string, unknown> } : {}),
    ...(typeof b.startedAt === 'number' ? { startedAt: b.startedAt } : {}),
    ...(typeof b.endedAt === 'number' ? { endedAt: b.endedAt } : {}),
  };
}

/**
 * Convert one transcript page into chat messages.
 * @param messages - core messages for the page, in chronological order.
 * @param uuids - parallel transcript uuids; supplied as stable message ids so
 *   rows keep their identity across a reload or an older-page prepend.
 * @returns the chat messages, with tool results folded into their tool calls.
 */
export function transcriptToChatMessages(messages: unknown[], uuids?: string[]): ChatMessage[] {
  const chatMsgs: ChatMessage[] = (messages as Array<Record<string, unknown>>).map((m, i) => {
    const raw = m?.content ?? [];
    let blocks: StreamBlock[];
    if (typeof raw === 'string') {
      blocks = [{ type: 'text', content: stripCompactWrapper(raw), state: 'done' }];
    } else if (Array.isArray(raw)) {
      blocks = (raw as Array<Record<string, unknown>>).map(toStreamBlock);
    } else {
      blocks = [];
    }

    const id = uuids?.[i] ?? (typeof m?.id === 'string' && m.id
      ? m.id
      : `msg-${typeof m?.timestamp === 'number' ? m.timestamp : i}-${i}`);
    const role = m?.role === 'assistant' || m?.role === 'system' ? m.role : 'user';

    return {
      id,
      role,
      content: '',
      blocks,
      timestamp: typeof m?.timestamp === 'number' ? m.timestamp : 0,
    };
  });

  // Walk backwards so a late tool_result finds the assistant turn that spawned
  // it (results always follow their call).
  for (let i = chatMsgs.length - 1; i >= 0; i--) {
    const msg = chatMsgs[i];
    if (!msg || msg.role !== 'user') continue;

    const toolResults: StreamBlock[] = [];
    const others: StreamBlock[] = [];
    for (const b of msg.blocks) {
      if (b.type === 'tool_result' && b.toolId) toolResults.push(b);
      else others.push(b);
    }

    for (const tr of toolResults) {
      let attached = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = chatMsgs[j];
        if (!prev || prev.role !== 'assistant') continue;
        const idx = prev.blocks.findIndex((b) => b.type === 'tool_use' && b.toolId === tr.toolId);
        if (idx >= 0) {
          prev.blocks[idx] = {
            ...prev.blocks[idx],
            toolResult: tr.content,
            toolMetadata: tr.toolMetadata,
            // An errored result marks its call errored too, so the card does
            // not render "Done" over a failure.
            ...(tr.state === 'error' ? { state: 'error' as const } : {}),
          };
          attached = true;
          break;
        }
      }
      // Unmatched results stay visible in their own message.
      if (!attached) others.push(tr);
    }

    if (others.length === 0) {
      chatMsgs.splice(i, 1);
    } else if (others.length !== msg.blocks.length) {
      chatMsgs[i] = { ...msg, blocks: others };
    }
  }

  return chatMsgs;
}