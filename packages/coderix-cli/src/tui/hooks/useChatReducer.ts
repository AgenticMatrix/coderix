import { useReducer } from 'react';

import type {
  ChatState, ChatAction, Message, ContentBlock,
  TextBlock, ThinkingBlock,
} from '../../types.js';
import { truncateResult } from './streamHelpers.js';

let messageIdCounter = 0;
export function nextMessageId(): number {
  return messageIdCounter++;
}

// ── Memory caps ──────────────────────────────────────────────────────────

/** Maximum messages to retain in TUI state. Oldest are dropped, but the first user message is preserved as an anchor. */
const MAX_TUI_MESSAGES = 200;
/** Maximum command history entries. */
const MAX_HISTORY = 1000;
/** Maximum cached sub-agent transcripts. */
const MAX_CACHED_AGENTS = 10;

function trimMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_TUI_MESSAGES) return messages;
  const excess = messages.length - MAX_TUI_MESSAGES;
  let startIdx = excess;
  const firstUserIdx = messages.findIndex(m => m.role === 'user');
  if (firstUserIdx >= 0 && firstUserIdx < excess) {
    startIdx = firstUserIdx;
  }
  return messages.slice(startIdx);
}

/**
 * Convert core ContentBlock to TUI ContentBlock.
 * Mirrors mapCoreBlockToTui from useAgentBridge.
 */
function coreBlockToTui(block: Record<string, unknown>): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', content: (block.text as string) ?? '' };
    case 'thinking':
      return { type: 'thinking', content: (block.thinking as string) ?? '' };
    case 'tool_use':
      return {
        type: 'tool_use',
        toolName: (block.name as string) ?? 'unknown',
        toolId: (block.id as string) ?? '',
        input: (block.input as Record<string, unknown>) ?? {},
        state: 'done' as const,
        result: undefined,
        duration: undefined,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolId: (block.tool_use_id as string) ?? '',
        toolName: (block.name as string) ?? '',
        content: truncateResult(typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? (block.content as Array<{ text?: string }>).map(c => c.text ?? '').join('')
            : ''),
        isError: (block.is_error as boolean) ?? false,
        duration: (block as Record<string, unknown>).duration as number | undefined,
        metadata: (block as Record<string, unknown>).metadata as Record<string, unknown> | undefined,
      };
    default:
      return { type: 'text', content: '' };
  }
}

/**
 * Convert core transcript messages to TUI Message objects.
 * Core messages have `content: string | ContentBlock[]`.
 *
 * Two-pass conversion: first maps all blocks, then injects tool_result
 * data into the corresponding tool_use blocks so inline renderers
 * (diffs, command output, etc.) work identically to live streaming.
 */
export function convertTranscriptToMessages(rawMessages: Array<{ role: string; content: unknown; timestamp?: number }>): Message[] {
  const base = Date.now();

  // Pass 1: convert raw → TUI messages
  const messages = rawMessages.map((raw, i) => {
    let blocks: ContentBlock[];
    let textContent: string;

    if (typeof raw.content === 'string') {
      textContent = raw.content;
      blocks = [{ type: 'text', content: raw.content }];
    } else if (Array.isArray(raw.content)) {
      blocks = raw.content.map((b: unknown) => coreBlockToTui(b as Record<string, unknown>));
      textContent = blocks
        .filter((b): b is ContentBlock & { content: string } => b.type === 'text')
        .map(b => (b as { content: string }).content)
        .join('');
    } else {
      textContent = '';
      blocks = [{ type: 'text', content: '' }];
    }

    return {
      id: base + i,
      role: raw.role as Message['role'],
      content: textContent,
      blocks,
      timestamp: raw.timestamp ?? (base + i),
    };
  });

  // Pass 2: find all tool_result blocks and inject results into the
  // corresponding tool_use blocks so they render inline (diffs, code, etc.)
  // Also populate toolName on tool_result blocks (core's ToolResultBlock
  // has no `name` field, only `tool_use_id`) so Pass 3 can filter correctly.
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const block of msg.blocks) {
      if (block.type !== 'tool_result' || !block.toolId) continue;
      for (const other of messages) {
        if (other.role !== 'assistant') continue;
        for (const b of other.blocks) {
          if (b.type === 'tool_use' && b.toolId === block.toolId) {
            b.state = 'done';
            b.result = {
              content: block.content,
              isError: block.isError,
              metadata: (block as { metadata?: Record<string, unknown> }).metadata,
            };
            b.duration = (block as { duration?: number }).duration;
            // Populate toolName for Pass 3 filtering
            (block as { toolName?: string }).toolName = b.toolName;
            break;
          }
        }
      }
    }
  }

  // Pass 3: remove tool_result blocks that are already rendered inline
  // (same filter as useAgentBridge). Without this, transcript loading
  // would show results twice — once inline and once as separate messages.
  const inlineTools = new Set([
    'read', 'bash', 'glob', 'grep',
    'WebSearch', 'WebFetch', 'write', 'update',
    'Agent', 'SendMessage',
  ]);

  // Build a tool_use_id → toolName map from all assistant messages
  // as a fallback when Pass 2 didn't set toolName on a tool_result.
  const toolUseNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const b of msg.blocks) {
      if (b.type === 'tool_use' && b.toolId) {
        toolUseNameMap.set(b.toolId, b.toolName);
      }
    }
  }

  return messages.filter((msg) => {
    if (msg.role !== 'user') return true;
    // Remove inline-rendered tool_result blocks
    const filtered = msg.blocks.filter(
      (b) => b.type !== 'tool_result' || !inlineTools.has(
        ((b as { toolName?: string }).toolName) ||
        toolUseNameMap.get((b as { toolId?: string }).toolId ?? '') ||
        '',
      ),
    );
    // Drop the message entirely if nothing remains
    return filtered.length > 0;
  });
}

/** Get plain text from Message.blocks for backward compat. */
export function getMessageText(m: Message): string {
  if (m.blocks.length > 0) {
    return m.blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.content)
      .join('');
  }
  return m.content;
}

/** Get thinking text from Message.blocks. */
export function getMessageThinking(m: Message): string | undefined {
  const thinkingBlock = m.blocks.find(
    (b): b is ThinkingBlock => b.type === 'thinking',
  );
  if (thinkingBlock) return thinkingBlock.content;
  return m.thinking;
}

// ── Reducer ─────────────────────────────────────────────────────────────

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    // Internal: route an action to savedMainMessages when in sub-agent view.
    // The wrapped action is applied to savedMainMessages instead of messages,
    // letting the main agent work in the background without contaminating the view.
    case 'ROUTE_TO_SAVED_MAIN': {
      // Guard: if the sub-agent view was already closed (via CLOSE_SUBAGENT_VIEW
      // in a prior dispatch within the same batch, or from a stale subAgentViewRef),
      // do nothing — savedMainMessages is null and operating on it would corrupt state.
      if (!state.subAgentView) return state;
      const altState = { ...state, messages: state.savedMainMessages ?? [] };
      const result = chatReducer(altState, action.action);
      return {
        ...state,
        savedMainMessages: result.messages,
        // Propagate isStreaming so that FINISH_ASSISTANT_RESPONSE / INTERRUPT
        // dispatched while viewing a sub-agent still unlock the main input
        isStreaming: result.isStreaming,
        // Track main agent streaming separately from sub-agent streaming
        mainStreaming: result.isStreaming,
      };
    }

    case 'SET_INPUT':
      return {
        ...state,
        inputText: action.text,
        cursorPosition: action.text.length,
        pasteBlocks: action.text === '' ? {} : state.pasteBlocks,
        pastePreviewVisible: action.text === '' ? false : state.pastePreviewVisible,
      };

    case 'ADD_USER_MESSAGE':
      return {
        ...state,
        messages: trimMessages([...state.messages, action.message]),
        inputText: '',
        cursorPosition: 0,
        error: null,
        pasteBlocks: {},
        pastePreviewVisible: false,
        turnOutputTokens: 0,
        turnEstimatedTokens: 0,
        turnStartedAt: Date.now(),
        isFrozen: false,
        interrupted: false,
      };

    case 'START_ASSISTANT_RESPONSE': {
      const assistantMsg: Message = {
        id: action.id,
        role: 'assistant',
        content: '',
        blocks: [],
        timestamp: Date.now(),
      };
      return {
        ...state,
        messages: trimMessages([...state.messages, assistantMsg]),
        isStreaming: true,
        currentTurnId: state.currentTurnId + 1,
      };
    }

    case 'START_BLOCK': {
      const isThinking = action.block.type === 'thinking';
      const isNonThinkingAfterThinking =
        !isThinking && state.thinkingStartedAt != null;

      let nextState = state;

      if (isThinking) {
        nextState = { ...nextState, thinkingStartedAt: Date.now() };
      }

      if (isNonThinkingAfterThinking) {
        const thinkingMsg = state.messages.find((m) => m.id === action.messageId);
        const thinkingBlock = thinkingMsg?.blocks.find(
          (b): b is ThinkingBlock => b.type === 'thinking',
        );
        const duration = Date.now() - state.thinkingStartedAt!;
        const tokens = thinkingBlock
          ? Math.max(1, Math.round(thinkingBlock.content.length / 4))
          : 0;
        nextState = {
          ...nextState,
          thinkingStartedAt: undefined,
          messages: nextState.messages.map((m) =>
            m.id === action.messageId
              ? { ...m, thinkingDuration: duration, thinkingTokens: tokens }
              : m,
          ),
        };
      }

      return {
        ...nextState,
        messages: nextState.messages.map((m) =>
          m.id === action.messageId
            ? {
                ...m,
                blocks: [...m.blocks, action.block],
              }
            : m,
        ),
      };
    }

    case 'APPEND_BLOCK_DELTA': {
      const msgs = state.messages;
      const lastIdx = msgs.length - 1;
      // Estimate tokens from this delta (text/thinking only). Real count replaces on message_stop.
      const deltaTokens = action.deltaType !== 'json'
        ? Math.max(1, Math.round(action.text.length / 4))
        : 0;

      // Fast path: during streaming, the target is always the last message
      if (lastIdx >= 0 && msgs[lastIdx]!.id === action.messageId) {
        const m = msgs[lastIdx]!;
        const newMsgs = msgs.slice(0, -1);

        if (m.blocks.length === 0) {
          const newBlock: ContentBlock =
            action.deltaType === 'thinking'
              ? { type: 'thinking', content: action.text } satisfies ThinkingBlock
              : { type: 'text', content: action.deltaType === 'text' ? action.text : '' };
          newMsgs.push({
            ...m,
            blocks: [newBlock],
          });
          return { ...state, messages: newMsgs, turnEstimatedTokens: state.turnEstimatedTokens + deltaTokens, turnOutputTokens: state.turnOutputTokens + deltaTokens };
        }

        const blocks = m.blocks.slice();
        const blockIdx = blocks.length - 1;
        const lastBlock = { ...blocks[blockIdx]! };

        if (action.deltaType === 'text' && lastBlock.type === 'text') {
          (lastBlock as TextBlock).content += action.text;
        } else if (action.deltaType === 'thinking') {
          if (lastBlock.type === 'thinking') {
            (lastBlock as ThinkingBlock).content += action.text;
          } else {
            blocks.push({
              type: 'thinking',
              content: action.text,
            } satisfies ThinkingBlock);
            newMsgs.push({
              ...m,
              blocks,
            });
            return { ...state, messages: newMsgs, turnEstimatedTokens: state.turnEstimatedTokens + deltaTokens, turnOutputTokens: state.turnOutputTokens + deltaTokens };
          }
        } else if (action.deltaType === 'json' && lastBlock.type === 'tool_use') {
          const partialStr = ((lastBlock.input as Record<string, unknown>)._partial as string || '') + action.text;
          try {
            const parsed = JSON.parse(partialStr) as Record<string, unknown>;
            lastBlock.input = { ...parsed, _partial: partialStr };
          } catch {
            lastBlock.input = { ...lastBlock.input, _partial: partialStr };
          }
        }

        blocks[blockIdx] = lastBlock;
        newMsgs.push({
          ...m,
          blocks,
        });
        return { ...state, messages: newMsgs, turnEstimatedTokens: state.turnEstimatedTokens + deltaTokens, turnOutputTokens: state.turnOutputTokens + deltaTokens };
      }

      // Slow path: scan all messages (should be rare — only if messageId
      // doesn't match the last message, e.g. during sub-agent transcript load)
      return {
        ...state,
        turnEstimatedTokens: state.turnEstimatedTokens + deltaTokens,
        turnOutputTokens: state.turnOutputTokens + deltaTokens,
        messages: msgs.map((m) => {
          if (m.id !== action.messageId) return m;

          if (m.blocks.length === 0) {
            const newBlock: ContentBlock =
              action.deltaType === 'thinking'
                ? { type: 'thinking', content: action.text } satisfies ThinkingBlock
                : { type: 'text', content: action.deltaType === 'text' ? action.text : '' };
            return {
              ...m,
              blocks: [newBlock],
            };
          }

          const blocks = [...m.blocks];
          const lastIdx2 = blocks.length - 1;
          const lastBlock = { ...blocks[lastIdx2] };

          if (action.deltaType === 'text' && lastBlock.type === 'text') {
            (lastBlock as TextBlock).content += action.text;
          } else if (action.deltaType === 'thinking') {
            if (lastBlock.type === 'thinking') {
              (lastBlock as ThinkingBlock).content += action.text;
            } else {
              blocks.push({
                type: 'thinking',
                content: action.text,
              } satisfies ThinkingBlock);
              return {
                ...m,
                blocks,
              };
            }
          } else if (action.deltaType === 'json' && lastBlock.type === 'tool_use') {
            const partialStr = ((lastBlock.input as Record<string, unknown>)._partial as string || '') + action.text;
            try {
              const parsed = JSON.parse(partialStr) as Record<string, unknown>;
              lastBlock.input = { ...parsed, _partial: partialStr };
            } catch {
              lastBlock.input = {
                ...lastBlock.input,
                _partial: partialStr,
              };
            }
          }

          blocks[lastIdx2] = lastBlock;
          return {
            ...m,
            blocks,
          };
        }),
      };
    }

    case 'SET_TOOL_USE_RESULT':
      return {
        ...state,
        messages: state.messages.map((m) => ({
          ...m,
          blocks: m.blocks.map((b) =>
            b.type === 'tool_use' && b.toolId === action.toolId
              ? {
                  ...b,
                  state: 'done' as const,
                  duration: action.duration,
                  result: action.result ? {
                    content: truncateResult(action.result.content),
                    isError: action.result.isError,
                    metadata: action.result.metadata,
                  } : undefined,
                }
              : b,
          ),
        })),
      };

    case 'STOP_BLOCK':
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.id !== action.messageId || m.blocks.length === 0) return m;
          const blocks = [...m.blocks];
          const lastIdx = blocks.length - 1;
          const lastBlock = { ...blocks[lastIdx] };

          if (lastBlock.type === 'tool_use') {
            const partial = (lastBlock.input as Record<string, unknown>)._partial as string;
            if (partial) {
              try {
                lastBlock.input = JSON.parse(partial);
              } catch {
                lastBlock.input = { _raw: partial };
              }
            }
          }
          blocks[lastIdx] = lastBlock;
          return { ...m, blocks };
        }),
      };

    case 'APPEND_ASSISTANT_TEXT': {
      const msgs = state.messages;
      const lastIdx = msgs.length - 1;
      if (lastIdx >= 0 && msgs[lastIdx]!.id === action.id) {
        const m = msgs[lastIdx]!;
        const newMsgs = msgs.slice(0, -1);
        newMsgs.push({ ...m, content: m.content + action.text });
        return { ...state, messages: newMsgs };
      }
      return {
        ...state,
        messages: msgs.map((m) =>
          m.id === action.id
            ? { ...m, content: m.content + action.text }
            : m,
        ),
      };
    }

    case 'APPEND_ASSISTANT_THINKING': {
      const msgs = state.messages;
      const lastIdx = msgs.length - 1;
      if (lastIdx >= 0 && msgs[lastIdx]!.id === action.id) {
        const m = msgs[lastIdx]!;
        const newMsgs = msgs.slice(0, -1);
        newMsgs.push({ ...m, thinking: (m.thinking ?? '') + action.text });
        return { ...state, messages: newMsgs };
      }
      return {
        ...state,
        messages: msgs.map((m) =>
          m.id === action.id
            ? { ...m, thinking: (m.thinking ?? '') + action.text }
            : m,
        ),
      };
    }

    case 'UPDATE_BLOCK_STATE': {
      const msgs = state.messages;
      // Scan from the end — tool_use blocks are in recent messages
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        const found = m.blocks.some(
          (b) => b.type === 'tool_use' && b.toolId === action.toolId,
        );
        if (found) {
          const newMsgs = msgs.slice(0);
          newMsgs[i] = {
            ...m,
            blocks: m.blocks.map((b) =>
              b.type === 'tool_use' && b.toolId === action.toolId
                ? { ...b, state: action.state }
                : b,
            ),
          };
          return { ...state, messages: newMsgs };
        }
      }
      return state;
    }

    case 'FINISH_ASSISTANT_RESPONSE': {
      let nextState = { ...state, isStreaming: false };
      if (state.thinkingStartedAt != null) {
        const lastMsg = state.messages[state.messages.length - 1];
        if (lastMsg?.role === 'assistant') {
          const thinkingBlock = lastMsg.blocks.find(
            (b): b is ThinkingBlock => b.type === 'thinking',
          );
          const duration = Date.now() - state.thinkingStartedAt;
          const tokens = thinkingBlock
            ? Math.max(1, Math.round(thinkingBlock.content.length / 4))
            : 0;
          nextState = {
            ...nextState,
            thinkingStartedAt: undefined,
            messages: nextState.messages.map((m) =>
              m.id === lastMsg.id
                ? { ...m, thinkingDuration: duration, thinkingTokens: tokens }
                : m,
            ),
          };
        }
      }
      return nextState;
    }

    case 'INTERRUPT': {
      // Mark all pending/executing tool blocks as done so the UI
      // transitions out of 'wait' status phase immediately.
      // Also finalize any in-progress thinking block so the ActivityLine
      // shows "Interrupted" instead of a spinning "Thinking…".
      let nextState = { ...state, isStreaming: false, interrupted: true };
      if (state.thinkingStartedAt != null) {
        const lastMsg = state.messages[state.messages.length - 1];
        if (lastMsg?.role === 'assistant') {
          const thinkingBlock = lastMsg.blocks.find(
            (b): b is ThinkingBlock => b.type === 'thinking',
          );
          const duration = Date.now() - state.thinkingStartedAt;
          const tokens = thinkingBlock
            ? Math.max(1, Math.round(thinkingBlock.content.length / 4))
            : 0;
          nextState = {
            ...nextState,
            thinkingStartedAt: undefined,
            messages: nextState.messages.map((m) =>
              m.id === lastMsg.id
                ? { ...m, thinkingDuration: duration, thinkingTokens: tokens }
                : m,
            ),
          };
        }
      }
      const msgs = nextState.messages.map((m) => {
        if (m.role !== 'assistant') return m;
        let changed = false;
        const blocks = m.blocks.map((b) => {
          if (b.type === 'tool_use' && (b.state === 'pending' || b.state === 'executing')) {
            changed = true;
            return { ...b, state: 'done' as const };
          }
          return b;
        });
        return changed ? { ...m, blocks } : m;
      });
      return { ...nextState, messages: msgs };
    }

    case 'SHOW_EXIT_HINT':
      return { ...state, exitHint: true };

    case 'HIDE_EXIT_HINT':
      return { ...state, exitHint: false };

    case 'INTERRUPT_AND_UNDO': {
      // Find the last user message — this is the one that started the
      // turn we want to undo. Remove it and everything after it, then
      // restore the user's input text so they can edit and resubmit.
      const msgs = state.messages;
      let lastUserIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1) {
        return { ...state, isStreaming: false, interrupted: true, turnUndone: true };
      }
      const undoneMsg = msgs[lastUserIdx]!;
      // Extract text from the undone user message's blocks
      const textBlocks = undoneMsg.blocks.filter((b): b is TextBlock => b.type === 'text');
      const restoredText = textBlocks.map((b) => b.content).join('\n');
      return {
        ...state,
        isStreaming: false,
        turnUndone: true,
        error: null,
        messages: msgs.slice(0, lastUserIdx),
        inputText: restoredText,
        cursorPosition: restoredText.length,
      };
    }

    case 'TOGGLE_THINKING':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? { ...m, thinkingExpanded: !m.thinkingExpanded }
            : m,
        ),
      };

    case 'TOGGLE_TOOLS':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? { ...m, toolsExpanded: !m.toolsExpanded }
            : m,
        ),
      };

    case 'TOGGLE_ALL_EXPAND': {
      const hasCollapsedTools = state.messages.some((m) => {
        const toolCount = m.blocks.filter(b => b.type === 'tool_use').length;
        return toolCount > 3 && !m.toolsExpanded;
      });
      return {
        ...state,
        messages: state.messages.map((m) => ({
          ...m,
          toolsExpanded: hasCollapsedTools ? true : false,
        })),
      };
    }

    case 'TOGGLE_ALL_CONTENT': {
      const hasCollapsedContent = state.messages.some((m) => {
        const hasThinking = !!m.thinking || m.blocks.some(b => b.type === 'thinking');
        return hasThinking && !m.thinkingExpanded;
      });
      const expandContent = hasCollapsedContent || !state.contentExpanded;
      return {
        ...state,
        contentExpanded: expandContent,
        messages: state.messages.map((m) => ({
          ...m,
          thinkingExpanded: expandContent ? true : false,
        })),
      };
    }

    case 'OPEN_SUBAGENT_VIEW': {
      const cached = state.subAgentMessageCache[action.agentId];
      return {
        ...state,
        subAgentView: { agentId: action.agentId },
        lastAgentViewId: action.agentId,
        savedMainMessages: state.savedMainMessages ?? state.messages,
        messages: cached ?? [],
        isStreaming: false,
        isFrozen: false,
      };
    }

    case 'CLOSE_SUBAGENT_VIEW': {
      // Guard: if no sub-agent view is active, this is a redundant close
      // (e.g. double-Esc, or TeamPanel __main__ selection without a view).
      // Saving an empty savedMainMessages would destroy the main messages.
      if (!state.subAgentView) return state;
      const currentAgentId = state.subAgentView.agentId;
      let updatedCache = currentAgentId
        ? { ...state.subAgentMessageCache, [currentAgentId]: state.messages }
        : state.subAgentMessageCache;

      // Evict oldest entries if cache exceeds MAX_CACHED_AGENTS
      const cacheKeys = Object.keys(updatedCache);
      if (cacheKeys.length > MAX_CACHED_AGENTS) {
        const keysToEvict = cacheKeys
          .filter(k => k !== currentAgentId)
          .slice(0, cacheKeys.length - MAX_CACHED_AGENTS);
        for (const key of keysToEvict) {
          delete updatedCache[key];
        }
        updatedCache = { ...updatedCache };
      }

      return {
        ...state,
        subAgentView: null,
        messages: state.savedMainMessages ?? [],
        savedMainMessages: null,
        subAgentMessageCache: updatedCache,
        isStreaming: false,
      };
    }

    case 'LOAD_SUBAGENT_TRANSCRIPT': {
      const updatedCache = {
        ...state.subAgentMessageCache,
        [action.agentId]: action.messages,
      };
      // Only update displayed messages when still viewing this sub-agent.
      // Otherwise a polling interval tick that fires after CLOSE_SUBAGENT_VIEW
      // but before effect cleanup would overwrite the restored main messages.
      if (state.subAgentView?.agentId !== action.agentId) {
        return { ...state, subAgentMessageCache: updatedCache };
      }
      return {
        ...state,
        messages: action.messages,
        subAgentMessageCache: updatedCache,
      };
    }

    case 'SHOW_AGENT_PICKER':
      return { ...state, agentPicker: true };

    case 'HIDE_AGENT_PICKER':
      return { ...state, agentPicker: false };

    case 'TOGGLE_TASK_PANEL':
      return { ...state, taskPanelDismissed: !state.taskPanelDismissed };

    case 'TOGGLE_TODO_PANEL':
      return { ...state, todoPanelDismissed: !state.todoPanelDismissed };

    case 'TOGGLE_TEAM_PANEL':
      return { ...state, teamPanelDismissed: !state.teamPanelDismissed };

    case 'SET_COMMAND_PICKER_INDEX':
      return { ...state, commandPickerIndex: action.index };

    case 'SHOW_TEAM_PICKER':
      return { ...state, teamPicker: true };

    case 'HIDE_TEAM_PICKER':
      return { ...state, teamPicker: false };

    case 'SHOW_MEMORY_PICKER':
      return { ...state, memoryPicker: true };

    case 'HIDE_MEMORY_PICKER':
      return { ...state, memoryPicker: false };

    case 'SHOW_SESSION_PICKER':
      return { ...state, sessionPicker: true };

    case 'HIDE_SESSION_PICKER':
      return { ...state, sessionPicker: false };

    case 'FREEZE_DISPLAY':
      return { ...state, isFrozen: true };

    case 'UNFREEZE_DISPLAY':
      return { ...state, isFrozen: false };

    case 'SET_MODE':
      return { ...state, mode: action.mode };

    case 'SET_CURSOR':
      return {
        ...state,
        cursorPosition: Math.max(0, Math.min(action.position, state.inputText.length)),
      };

    case 'INSERT_CHAR': {
      const pos = Math.max(0, Math.min(state.cursorPosition, state.inputText.length));
      const newText =
        state.inputText.slice(0, pos) +
        action.char +
        state.inputText.slice(pos);
      return {
        ...state,
        inputText: newText,
        cursorPosition: pos + action.char.length,
      };
    }

    case 'DELETE_CHAR': {
      const cp = Math.max(0, Math.min(state.cursorPosition, state.inputText.length));
      if (action.position === 'before') {
        if (cp === 0) return state;
        const newText =
          state.inputText.slice(0, cp - 1) + state.inputText.slice(cp);
        return {
          ...state,
          inputText: newText,
          cursorPosition: cp - 1,
        };
      } else {
        if (cp >= state.inputText.length) return state;
        const newText =
          state.inputText.slice(0, cp) + state.inputText.slice(cp + 1);
        return {
          ...state,
          inputText: newText,
          cursorPosition: cp,
        };
      }
    }

    case 'SET_ERROR':
      // Suppress errors from the aborted stream when the turn was undone
      if (state.turnUndone) return { ...state, turnUndone: false };
      return { ...state, error: action.error, isStreaming: false };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    case 'CLEAR_CHAT':
      return { ...state, messages: [] };

    case 'LOAD_CHAT':
      return {
        ...state,
        messages: trimMessages(action.messages),
        turns: action.turns,
        isStreaming: action.isStreaming ?? false,
      };

    case 'SHOW_APPROVAL':
      return { ...state, approvalReq: action.req };

    case 'HIDE_APPROVAL':
      return { ...state, approvalReq: null };

    case 'SHOW_QUESTION':
      return { ...state, questionReq: { questions: action.questions } };

    case 'HIDE_QUESTION':
      return { ...state, questionReq: null };

    case 'LOAD_HISTORY':
      return { ...state, history: action.history };

    case 'ADD_HISTORY': {
      const trimmed = action.line.trim();
      if (trimmed.length === 0) return state;
      const prev = state.history;
      if (prev.length > 0 && prev[prev.length - 1] === trimmed) return state;
      const next = [...prev, trimmed];
      return {
        ...state,
        history: next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next,
      };
    }

    case 'SET_HISTORY_INDEX':
      return {
        ...state,
        historyIndex: action.index,
        historyScratch: action.scratch !== undefined ? action.scratch : state.historyScratch,
      };

    case 'ADD_PASTE_BLOCK': {
      const addLines = action.text.split(/\r?\n|\r/).length;
      const pos = Math.max(0, Math.min(state.cursorPosition, state.inputText.length));
      const beforeCursor = state.inputText.slice(0, pos);

      // Merge with immediately preceding paste marker (chunked paste)
      const prevMarker = beforeCursor.match(
        /\[Pasted text #(\d+) \+(\d+) lines\]$/,
      );
      if (prevMarker) {
        const prevId = Number(prevMarker[1]);
        const prevContent = state.pasteBlocks[prevId] ?? '';
        const mergedContent = prevContent + action.text;
        const totalLines = Number(prevMarker[2]) + addLines;
        const newMarker = `[Pasted text #${prevId} +${totalLines} lines]`;
        const newText =
          beforeCursor.slice(0, -prevMarker[0].length) +
          newMarker +
          state.inputText.slice(pos);
        return {
          ...state,
          inputText: newText,
          cursorPosition: pos - prevMarker[0].length + newMarker.length,
          pasteBlocks: { ...state.pasteBlocks, [prevId]: mergedContent },
          pastePreviewVisible: true,
        };
      }

      // New paste block
      let pasteId = 1;
      while (state.pasteBlocks[pasteId] !== undefined) pasteId++;
      const marker = `[Pasted text #${pasteId} +${addLines - 1} lines]`;
      const newText = beforeCursor + marker + state.inputText.slice(pos);
      return {
        ...state,
        inputText: newText,
        cursorPosition: pos + marker.length,
        pasteBlocks: { ...state.pasteBlocks, [pasteId]: action.text },
        pastePreviewVisible: true,
      };
    }

    case 'TOGGLE_PASTE_PREVIEW':
      if (Object.keys(state.pasteBlocks).length === 0) return state;
      return {
        ...state,
        pastePreviewVisible: !state.pastePreviewVisible,
      };

    case 'UPDATE_TOKEN_USAGE': {
      const inputTokens = action.usage.inputTokens ?? 0;
      const outputTokens = action.usage.outputTokens ?? 0;
      const cacheCreationInputTokens = action.usage.cacheCreationInputTokens ?? 0;
      const cacheReadInputTokens = action.usage.cacheReadInputTokens ?? 0;
      const turnCost =
        (inputTokens / 1_000_000) * state.inputPrice +
        (outputTokens / 1_000_000) * state.outputPrice +
        (cacheReadInputTokens / 1_000_000) * state.cacheReadPrice;
      // skipDisplay: sub-agent tokens should accumulate cost without
      // overwriting the main agent's ctx display data
      const tokenUsage = action.skipDisplay
        ? state.tokenUsage
        : { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens };
      // Replace estimated tokens with real API count.
      // During streaming, deltas are estimated as chars/4. When the response
      // completes, we subtract the estimates and add the real output_tokens.
      const realOutputTokens = outputTokens;
      const correctedOutput = state.turnOutputTokens - state.turnEstimatedTokens + realOutputTokens;
      return {
        ...state,
        tokenUsage,
        accumulatedCost: state.accumulatedCost + turnCost,
        turnOutputTokens: correctedOutput,
        turnEstimatedTokens: 0,
      };
    }

    case 'EVICT_AGENT_CACHE': {
      const { [action.agentId]: _, ...rest } = state.subAgentMessageCache;
      return { ...state, subAgentMessageCache: rest };
    }

    case 'TOGGLE_BRIEF_MODE':
      return { ...state, briefMode: !state.briefMode };

    case 'QUEUED_MESSAGE':
      return { ...state, queuedCount: state.queuedCount + 1 };

    case 'DEQUEUED_MESSAGE':
      return { ...state, queuedCount: Math.max(0, state.queuedCount - 1) };

    default:
      return state;
  }
}

export function createInitialState(model: string, inputPrice = 0.5, outputPrice = 2.0, cacheReadPrice = 0.05): ChatState {
  return {
    sessionId: '',
    permissionMode: 'auto',
    config: {
      cwd: process.cwd(),
      model,
      baseUrl: '',
      apiKey: '',
      inputPrice,
      outputPrice,
      cacheReadPrice,
      maxContext: 0,
      briefMode: false,
      autoCompactEnabled: true,
      compactThreshold: 0.85,
    },
    messages: [],
    isStreaming: false,
    mainStreaming: false,
    turnUndone: false,
    exitHint: false,
    model,
    error: null,
    inputText: '',
    cursorPosition: 0,
    mode: 'auto',
    turns: [],
    currentTurnId: 0,
    approvalReq: null,
    questionReq: null,
    history: [],
    historyIndex: -1,
    historyScratch: '',
    pasteBlocks: {},
    pastePreviewVisible: false,
    contentExpanded: false,
    subAgentView: null,
    savedMainMessages: null,
    subAgentMessageCache: {},
    lastAgentViewId: null,
    agentPicker: false,
    taskPanelDismissed: false,
    thinkingStartedAt: undefined,
    todoPanelDismissed: false,
    teamPanelDismissed: false,
    commandPickerIndex: -1,
    teamPicker: false,
    memoryPicker: false,
    sessionPicker: false,
    isFrozen: false,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    accumulatedCost: 0,
    inputPrice,
    outputPrice,
    cacheReadPrice,
    briefMode: false,
    turnOutputTokens: 0,
    turnEstimatedTokens: 0,
    turnStartedAt: 0,
    queuedCount: 0,
    interrupted: false,
  };
}

/** Replace paste markers with actual content. */
export function expandPasteMarkers(text: string, blocks: Record<number, string>): string {
  return text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (_m, id) => {
    return blocks[Number(id)] ?? _m;
  });
}

export function useChatReducer(model: string, inputPrice?: number, outputPrice?: number, cacheReadPrice?: number) {
  return useReducer(chatReducer, { model, inputPrice, outputPrice, cacheReadPrice }, (init) => createInitialState(init.model, init.inputPrice, init.outputPrice, init.cacheReadPrice));
}
