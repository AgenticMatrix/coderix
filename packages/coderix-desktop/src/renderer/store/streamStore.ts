import { create } from 'zustand';
import type { StreamBlock } from '../types.js';
import type { AggregatedTokenUsage } from './types.js';
import { createId } from './types.js';
import type { ChatMessage } from './types.js';
import { useChatStore } from './chatStore.js';
import {
  onStreamBlock,
  onStreamDone,
  onStreamError,
  onTokenUsage,
} from '../ipc-client.js';

export interface StreamState {
  /**
   * The currently building assistant message (accumulated blocks).
   * Reset to null when streaming ends.
   */
  currentMessage: {
    id: string;
    blocks: StreamBlock[];
    content: string;
  } | null;

  /** Aggregated token usage across all turns of the current session */
  tokenUsage: AggregatedTokenUsage;

  /** Cleanup functions for IPC event listeners */
  _cleanups: Array<() => void>;

  // Actions
  /** Register all stream event listeners. Called once at app init. */
  startListening: () => void;
  /** Unregister all stream event listeners. Called at app teardown. */
  stopListening: () => void;
}

/**
 * Stream store — bridges the preload IPC stream events to the chat store.
 *
 * It listens to three events from the main process:
 *   1. `stream:block` — a content block (text, tool_use, tool_result, thinking, system)
 *   2. `stream:done` — stream completed successfully
 *   3. `stream:error` — stream errored
 *
 * It also listens to `state:tokenUsage` for real-time token stats.
 *
 * Blocks are accumulated into `currentMessage` during streaming. When the
 * stream completes, the message is committed to the chat store's message list.
 *
 * The preload API emits blocks through a single unified `onStreamBlock` channel.
 * The block's `type` field differentiates between text, tool_use, tool_result,
 * thinking, and system blocks. This store handles the full lifecycle:
 *
 *   blockStart (type set, content empty) → blockDelta (type set, content has data) → blockStop (state: 'done')
 *
 * For simplicity, each block update replaces or appends to the correct entry
 * in the blocks array, keyed by toolId (for tool blocks) or type (for text/thinking/system).
 */
export const useStreamStore = create<StreamState>()((set, get) => ({
  currentMessage: null,
  tokenUsage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: 0,
    currency: 'USD',
  },
  _cleanups: [],

  startListening: () => {
    // Prevent double-registration
    const existing = get()._cleanups;
    if (existing.length > 0) return;

    const cleanups: Array<() => void> = [];

    // ── Stream Block ──────────────────────────────────────
    const unsubBlock = onStreamBlock((block: StreamBlock) => {
      const state = get();
      let msg = state.currentMessage;

      // Create message on first block
      if (!msg) {
        msg = {
          id: createId(),
          blocks: [],
          content: '',
        };
      }

      // Upsert block: find by toolId for tool blocks, or by type for text/thinking/system
      // Special handling: tool_result blocks get attached to their matching tool_use
      // instead of being added as separate blocks, so output renders below input.
      const existingIdx = msg.blocks.findIndex((b) => {
        if (block.toolId && b.toolId) return b.toolId === block.toolId;
        if (block.type === 'tool_use') {
          return b.type === 'tool_use' && b.toolId === block.toolId;
        }
        if (block.type === 'tool_result') {
          return b.type === 'tool_use' && b.toolId === block.toolId;
        }
        return b.type === block.type;
      });

      if (existingIdx >= 0) {
        // Update existing block (delta or stop)
        const updated = [...msg.blocks];
        const existing = { ...updated[existingIdx] };

        // Attach tool_result content to the matching tool_use block
        if (block.type === 'tool_result' && existing.type === 'tool_use') {
          existing.toolResult = block.content;
          updated[existingIdx] = existing;
          msg = { ...msg, blocks: updated };
        } else {
          // Replace content — ipc-client already accumulates deltas
          if (block.content !== undefined) {
            existing.content = block.content;
          }
          if (block.state) existing.state = block.state;
          if (block.toolInput) existing.toolInput = { ...existing.toolInput, ...block.toolInput };
          if (block.toolName) existing.toolName = block.toolName;

          updated[existingIdx] = existing;
          msg = { ...msg, blocks: updated };
        }
      } else if (block.type === 'tool_result' && block.toolId) {
        // Tool_result arrived after the previous turn was committed to chatStore.
        // Search the last assistant message in chatStore for the matching tool_use.
        const chatMessages = useChatStore.getState().messages;
        let attached = false;
        for (let i = chatMessages.length - 1; i >= 0; i--) {
          const chatMsg = chatMessages[i];
          if (chatMsg.role !== 'assistant') continue;
          const toolUseIdx = chatMsg.blocks.findIndex(
            (b) => b.type === 'tool_use' && b.toolId === block.toolId,
          );
          if (toolUseIdx >= 0) {
            const updatedBlocks = [...chatMsg.blocks];
            updatedBlocks[toolUseIdx] = {
              ...updatedBlocks[toolUseIdx],
              toolResult: block.content,
            };
            useChatStore.setState((state) => ({
              messages: state.messages.map((m) =>
                m.id === chatMsg.id ? { ...m, blocks: updatedBlocks } : m,
              ),
            }));
            attached = true;
            break;
          }
        }
        // Only add as standalone if we couldn't attach it anywhere
        if (!attached) {
          msg = { ...msg, blocks: [...msg.blocks, { ...block }] };
        }
      } else {
        // New block (text, thinking, system, etc.)
        msg = { ...msg, blocks: [...msg.blocks, { ...block }] };
      }

      // Set message content from latest text block (ipc-client already accumulates)
      if (block.content !== undefined && (block.type === 'text' || block.type === 'thinking')) {
        msg = { ...msg, content: block.content };
      }

      set({ currentMessage: msg });
    });
    cleanups.push(unsubBlock);

    // ── Stream Done ────────────────────────────────────────
    const unsubDone = onStreamDone(() => {
      const { currentMessage } = get();
      if (currentMessage) {
        // Commit the message to the chat store
        const chatMsg: ChatMessage = {
          id: currentMessage.id,
          role: 'assistant',
          content: currentMessage.content,
          blocks: currentMessage.blocks,
          timestamp: Date.now(),
        };
        useChatStore.setState((state) => ({
          messages: [...state.messages, chatMsg],
          isStreaming: false,
          streamingContent: '',
        }));
        set({ currentMessage: null });
      } else {
        useChatStore.setState({ isStreaming: false });
      }
    });
    cleanups.push(unsubDone);

    // ── Stream Error ───────────────────────────────────────
    const unsubError = onStreamError((error: string) => {
      useChatStore.setState({ error: error, isStreaming: false });
      set({ currentMessage: null });
    });
    cleanups.push(unsubError);

    // ── Token Usage ────────────────────────────────────────
    const unsubToken = onTokenUsage((stats) => {
      set((state) => ({
        tokenUsage: {
          inputTokens: (state.tokenUsage.inputTokens ?? 0) + (stats.inputTokens ?? 0),
          outputTokens: (state.tokenUsage.outputTokens ?? 0) + (stats.outputTokens ?? 0),
          cacheReadTokens: (state.tokenUsage.cacheReadTokens ?? 0) + (stats.cacheReadTokens ?? 0),
          cacheWriteTokens: (state.tokenUsage.cacheWriteTokens ?? 0) + (stats.cacheWriteTokens ?? 0),
          totalCost: (state.tokenUsage.totalCost ?? 0) + (stats.cost ?? 0),
          currency: stats.currency || state.tokenUsage.currency,
        },
      }));
    });
    cleanups.push(unsubToken);

    set({ _cleanups: cleanups });
  },

  stopListening: () => {
    const { _cleanups } = get();
    for (const cleanup of _cleanups) {
      cleanup();
    }
    set({ _cleanups: [] });
  },
}));
