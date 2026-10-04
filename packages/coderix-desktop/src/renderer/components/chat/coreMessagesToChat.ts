import type { ChatMessage } from '../../store/types';
import type { StreamBlock } from '../../types';

/**
 * Convert a core `Message[]` (the shape the engine persists / the session-load
 * path returns) into the renderer's `ChatMessage[]`, mirroring the session-load
 * conversion in App.tsx:
 *
 *   - normalize content blocks to the StreamBlock shape the UI renders
 *   - pair each tool_result into its preceding tool_use (so the tool card shows
 *     the result, and the standalone tool-result user message is dropped)
 *
 * The result feeds `buildTrajectoryCalls` in exactly the same way the main
 * agent's hydrated transcript does, so the sub-agent side pane renders the full
 * conversation (user turns, thinking, tool calls, final answer) identically.
 */

function stripCompactWrapper(content: string): string {
  const marker = '[Latest message]';
  const idx = content.lastIndexOf(marker);
  if (idx < 0) return content;
  const after = content.slice(idx + marker.length).trim();
  return after || content;
}

function normalizeContent(b: Record<string, unknown>): string {
  let content: unknown = b.text ?? b.thinking ?? b.content ?? '';
  if (Array.isArray(content)) {
    content = (content as unknown[])
      .map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? '')))
      .join('\n');
  }
  return typeof content === 'string' ? content : '';
}

const RENDERABLE_TYPES = ['text', 'tool_use', 'tool_result', 'thinking'];

export function coreMessagesToChatMessages(messages: unknown[]): ChatMessage[] {
  const chatMsgs: ChatMessage[] = (messages as Array<Record<string, unknown>>).map(
    (raw, i) => {
      const content = raw?.content;
      let blocks: StreamBlock[];
      if (typeof content === 'string') {
        blocks = [{ type: 'text', content: stripCompactWrapper(content), state: 'done' }];
      } else if (Array.isArray(content)) {
        blocks = (content as Array<Record<string, unknown>>).map((b) => {
          const type = RENDERABLE_TYPES.includes(b.type as string)
            ? (b.type as StreamBlock['type'])
            : 'text';
          return {
            type,
            content: normalizeContent(b),
            // tool_use starts as "executing"; the pairing pass below upgrades
            // it to "done" (or "error") once its tool_result is attached.
            state: (type === 'tool_use' ? 'executing' : b.is_error ? 'error' : 'done') as StreamBlock['state'],
            ...(b.tool_use_id ? { toolId: b.tool_use_id as string } : {}),
            ...(b.id ? { toolId: b.id as string } : {}),
            ...(b.name ? { toolName: b.name as string } : {}),
            ...(b.input ? { toolInput: b.input as Record<string, unknown> } : {}),
            ...(b.metadata ? { toolMetadata: b.metadata as Record<string, unknown> } : {}),
            ...(typeof b.startedAt === 'number' ? { startedAt: b.startedAt } : {}),
            ...(typeof b.endedAt === 'number' ? { endedAt: b.endedAt } : {}),
          };
        });
      } else {
        blocks = [];
      }

      const role = raw?.role;
      return {
        id: (raw?.id as string) || `sub-${i}-${Math.random().toString(36).slice(2, 8)}`,
        role: (role === 'user' || role === 'assistant' ? role : 'system') as ChatMessage['role'],
        content: '',
        blocks,
        timestamp: typeof raw?.timestamp === 'number' ? raw.timestamp : 0,
      };
    },
  );

  // Pair tool_result blocks with their matching tool_use blocks (walking
  // backwards so a late tool_result finds the assistant turn that spawned it).
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
        const idx = prev.blocks.findIndex(
          (b) => b.type === 'tool_use' && b.toolId === tr.toolId,
        );
        if (idx >= 0) {
          prev.blocks[idx] = {
            ...prev.blocks[idx],
            toolResult: tr.content,
            toolMetadata: tr.toolMetadata,
            state: (tr.state === 'error' ? 'error' : 'done') as StreamBlock['state'],
          };
          attached = true;
          break;
        }
      }
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
