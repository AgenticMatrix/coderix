import { create } from 'zustand';
import type { StreamBlock } from '../types.js';
import type { AggregatedTokenUsage } from './types.js';
import { createId } from './types.js';
import type { ChatMessage } from './types.js';
import { useChatStore } from './chatStore.js';
import { useSessionStore } from './sessionStore.js';
import {
  onStreamBlock,
  onStreamDone,
  onStreamError,
  onTokenUsage,
} from '../ipc-client.js';

// Stream blocks arrive at high frequency (one IPC message per text delta), and
// each one currently forces a React render via `set()`. Batching accumulates
// deltas into a single pending message and flushes once per animation frame, so
// a burst of N deltas produces at most one render instead of N. This mirrors
// agentstation's approach of coalescing rapid stream events before committing
// them to the UI. The pending buffers are module-scoped and keyed by session id
// so concurrent streams never coalesce into each other, and they never trigger
// a render themselves.
interface PendingMsg { id: string; blocks: StreamBlock[]; content: string; }
const pendingBySession = new Map<string, { msg: PendingMsg | null; raf: number | null }>();

function getPending(sessionId: string): { msg: PendingMsg | null; raf: number | null } {
  let p = pendingBySession.get(sessionId);
  if (!p) {
    p = { msg: null, raf: null };
    pendingBySession.set(sessionId, p);
  }
  return p;
}

/** Drop any buffered blocks for one session (used on error/interrupt/teardown). */
function discardPending(sessionId: string): void {
  const p = pendingBySession.get(sessionId);
  if (!p) return;
  if (p.raf !== null) {
    cancelAnimationFrame(p.raf);
    p.raf = null;
  }
  p.msg = null;
}

function emptyTokenUsage(): AggregatedTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCost: 0,
    currency: 'USD',
  };
}

function accumulateTokenUsage(
  acc: AggregatedTokenUsage,
  stats: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; cost?: number; currency?: string },
): AggregatedTokenUsage {
  return {
    inputTokens: (acc.inputTokens ?? 0) + (stats.inputTokens ?? 0),
    outputTokens: (acc.outputTokens ?? 0) + (stats.outputTokens ?? 0),
    cacheReadTokens: (acc.cacheReadTokens ?? 0) + (stats.cacheReadTokens ?? 0),
    cacheWriteTokens: (acc.cacheWriteTokens ?? 0) + (stats.cacheWriteTokens ?? 0),
    totalCost: (acc.totalCost ?? 0) + (stats.cost ?? 0),
    currency: stats.currency || acc.currency,
  };
}

export interface StreamState {
  /**
   * The currently building assistant message for the *viewed* session
   * (accumulated blocks). Reset to null when that session's stream ends.
   */
  currentMessage: PendingMsg | null;

  /** Building assistant messages for backgrounded sessions, keyed by session. */
  currentMessageBySession: Record<string, PendingMsg>;

  /** Aggregated token usage for the viewed session. */
  tokenUsage: AggregatedTokenUsage;

  /** Aggregated token usage for backgrounded sessions. */
  tokenUsageBySession: Record<string, AggregatedTokenUsage>;

  /** Cleanup functions for IPC event listeners */
  _cleanups: Array<() => void>;

  // Actions
  /** Register all stream event listeners. Called once at app init. */
  startListening: () => void;
  /** Unregister all stream event listeners. Called at app teardown. */
  stopListening: () => void;
  /** Swap the viewed session: stash the current session's stream state and load
   *  the target's cached state (coordinated with chatStore.setSessionId). */
  setViewedSession: (id: string | null) => void;
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
 * Blocks are accumulated into the owning session's `currentMessage` (flat for the
 * viewed session, `currentMessageBySession` for backgrounded ones) during
 * streaming. When a stream completes, the message is committed to that session's
 * transcript. Events are **routed** to their owning session — never dropped — so
 * switching sessions leaves every background stream running and accumulating.
 */
export const useStreamStore = create<StreamState>()((set, get) => ({
  currentMessage: null,
  currentMessageBySession: {},
  tokenUsage: emptyTokenUsage(),
  tokenUsageBySession: {},
  _cleanups: [],

  setViewedSession: (id: string | null) => {
    const oldId = useChatStore.getState().sessionId;
    const state = get();

    const currentMessageBySession = { ...state.currentMessageBySession };
    const tokenUsageBySession = { ...state.tokenUsageBySession };
    if (oldId) {
      if (state.currentMessage) currentMessageBySession[oldId] = state.currentMessage;
      tokenUsageBySession[oldId] = state.tokenUsage;
    }

    const nextCurrent = id ? (currentMessageBySession[id] ?? null) : null;
    const nextUsage = id ? (tokenUsageBySession[id] ?? emptyTokenUsage()) : emptyTokenUsage();
    if (id) {
      delete currentMessageBySession[id];
      delete tokenUsageBySession[id];
    }

    set({
      currentMessage: nextCurrent,
      tokenUsage: nextUsage,
      currentMessageBySession,
      tokenUsageBySession,
    });
  },

  startListening: () => {
    // Prevent double-registration
    const existing = get()._cleanups;
    if (existing.length > 0) return;

    const cleanups: Array<() => void> = [];

    // Resolve the session a stream event belongs to, falling back to the viewed
    // session when an event is untagged.
    const sessionOf = (sessionId?: string): string =>
      sessionId || useChatStore.getState().sessionId || '';

    const viewedSession = (): string | null => useChatStore.getState().sessionId;

    // Read a session's in-progress assistant message (flat if viewed, map slot
    // if backgrounded).
    const getCurrent = (sessionId: string): PendingMsg | null => {
      if (sessionId === viewedSession()) return get().currentMessage;
      return get().currentMessageBySession[sessionId] ?? null;
    };

    // Write a session's in-progress assistant message to the right slot.
    const writeCurrent = (sessionId: string, msg: PendingMsg | null): void => {
      if (sessionId === viewedSession()) {
        set({ currentMessage: msg });
        return;
      }
      set((s) => {
        const next = { ...s.currentMessageBySession };
        if (msg === null) delete next[sessionId];
        else next[sessionId] = msg;
        return { currentMessageBySession: next };
      });
    };

    // Flush accumulated blocks for a session into the store as a single `set()`
    // (called once per animation frame, or synchronously on stream done so the
    // final partial message is never lost).
    const flushPendingBlocks = (sessionId: string) => {
      const p = pendingBySession.get(sessionId);
      if (!p) return;
      if (p.raf !== null) {
        cancelAnimationFrame(p.raf);
        p.raf = null;
      }
      const msg = p.msg;
      p.msg = null;
      if (msg) writeCurrent(sessionId, msg);
    };

    // Coalesce a block into a session's pending message and schedule one flush.
    const scheduleBlockFlush = (sessionId: string) => {
      const p = getPending(sessionId);
      if (p.raf !== null) return;
      p.raf = requestAnimationFrame(() => flushPendingBlocks(sessionId));
    };

    // Refresh the sidebar entry for a session once a turn finishes. A completed
    // turn is bumped optimistically so "turns"/time update immediately; a
    // delayed disk read then reconciles the exact count and title once the
    // engine's async JSONL/meta writes have landed.
    const refreshSidebarSession = (bump: boolean, sessionId?: string) => {
      const sid =
        sessionId ??
        useChatStore.getState().sessionId ??
        useSessionStore.getState().currentSessionId;
      if (!sid) return;
      if (bump) useSessionStore.getState().bumpSession(sid);
      setTimeout(() => {
        void useSessionStore.getState().refreshSession(sid);
      }, 400);
    };

    // Read a session's committed transcript (flat if viewed, map slot if not).
    const getMessages = (sessionId: string): ChatMessage[] => {
      if (sessionId === viewedSession()) return useChatStore.getState().messages;
      return useChatStore.getState().messagesBySession[sessionId] ?? [];
    };

    // Attach a tool_result to the matching tool_use across a session's committed
    // messages. Returns true when the result found a home.
    const attachToolResult = (sessionId: string, block: StreamBlock): boolean => {
      const chatMessages = getMessages(sessionId);
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        const chatMsg = chatMessages[i];
        if (chatMsg.role !== 'assistant') continue;
        const toolUseIdx = chatMsg.blocks.findIndex(
          (b) => b.type === 'tool_use' && b.toolId === block.toolId,
        );
        if (toolUseIdx >= 0) {
          useChatStore.getState().patchSessionMessages(
            sessionId,
            (msgs) =>
              msgs.map((m) =>
                m.id === chatMsg.id
                  ? {
                      ...m,
                      blocks: m.blocks.map((b, bi) =>
                        bi === toolUseIdx
                          ? { ...b, toolResult: block.content, toolMetadata: block.toolMetadata }
                          : b,
                      ),
                    }
                  : m,
              ),
          );
          return true;
        }
      }
      return false;
    };

    // ── Stream Block ──────────────────────────────────────
    const unsubBlock = onStreamBlock((block: StreamBlock) => {
      // Route the block to its owning session (never drop it): a backgrounded
      // session keeps accumulating into its own cache.
      const sid = sessionOf(block.sessionId);

      // Accumulate against the pending message when a flush is already
      // scheduled (mid-frame), otherwise against the last committed message.
      let msg = getPending(sid).msg ?? getCurrent(sid);

      // Tool_result arriving outside active streaming — attach directly
      // to the matching tool_use in already-committed messages.
      if (block.type === 'tool_result' && block.toolId && !msg) {
        if (attachToolResult(sid, block)) return;
        // Couldn't attach — create a minimal standalone message
        msg = {
          id: createId(),
          blocks: [{ ...block }],
          content: '',
        };
        getPending(sid).msg = msg;
        scheduleBlockFlush(sid);
        return;
      }

      // Stray blocks arriving after a stream was cancelled must not start a new
      // in-progress message. During a live stream `isStreaming` is true, so this
      // only filters out orphaned blocks.
      const isStreaming =
        sid === viewedSession()
          ? useChatStore.getState().isStreaming
          : (useChatStore.getState().streamingBySession[sid] ?? false);
      if (!msg && !isStreaming) {
        return;
      }

      // Create message on first block
      if (!msg) {
        msg = {
          id: createId(),
          blocks: [],
          content: '',
        };
      }

      // Upsert block: find by toolId for tool blocks, or by type for text/thinking/system
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
        const updated = [...msg.blocks];
        const existing = { ...updated[existingIdx] };

        if (block.type === 'tool_result' && existing.type === 'tool_use') {
          existing.toolResult = block.content;
          existing.toolMetadata = block.toolMetadata;
          updated[existingIdx] = existing;
          msg = { ...msg, blocks: updated };
        } else {
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
        // Tool_result arrived during active streaming — search committed
        // messages for the matching tool_use (may be from a prior turn).
        const attached = attachToolResult(sid, block);
        if (!attached) {
          msg = { ...msg, blocks: [...msg.blocks, { ...block }] };
        }
      } else {
        msg = { ...msg, blocks: [...msg.blocks, { ...block }] };
      }

      if (block.content !== undefined && (block.type === 'text' || block.type === 'thinking')) {
        msg = { ...msg, content: block.content };
      }

      getPending(sid).msg = msg;
      scheduleBlockFlush(sid);
    });
    cleanups.push(unsubBlock);

    // ── Stream Done ────────────────────────────────────────
    const unsubDone = onStreamDone((stopReason?: string, sessionId?: string) => {
      const sid = sessionOf(sessionId);

      // Commit any blocks still buffered (the last deltas of the turn may not
      // have flushed yet) before reading `currentMessage` below.
      flushPendingBlocks(sid);

      // A stop reason of 'tool_use' means this turn ended to run tools — the
      // engine will emit another assistant turn right after the tool results.
      // Keep streaming true in that case; only reset it on a terminal turn
      // (end_turn / max_tokens / stop_sequence / refusal, or undefined).
      const isToolTurn = stopReason === 'tool_use';
      const current = getCurrent(sid);
      if (current) {
        const chatMsg: ChatMessage = {
          id: current.id,
          role: 'assistant',
          content: current.content,
          blocks: current.blocks,
          timestamp: Date.now(),
        };
        useChatStore.getState().commitAssistantMessage(sid || undefined, chatMsg, isToolTurn);
        writeCurrent(sid, null);
      } else if (!isToolTurn) {
        useChatStore.getState().setSessionStreaming(sid || undefined, false);
      }
      refreshSidebarSession(true, sid);
    });
    cleanups.push(unsubDone);

    // ── Stream Error ───────────────────────────────────────
    const unsubError = onStreamError((error: string, code?: string, sessionId?: string) => {
      const sid = sessionOf(sessionId);

      // Drop any buffered partial message for this session's stream.
      discardPending(sid);

      // An interrupt (user pressed ⌘.) is not a real error — it just means the
      // in-flight query was aborted. Clear any partial message but don't surface
      // an error banner.
      if (code === 'INTERRUPTED') {
        writeCurrent(sid, null);
        useChatStore.getState().setSessionStreaming(sid || undefined, false);
        return;
      }

      // Surface the error banner only for the viewed session; a backgrounded
      // session just stops streaming (its error is re-read from disk on switch).
      if (sid === viewedSession()) {
        useChatStore.getState().setError(error);
      } else {
        useChatStore.getState().setSessionStreaming(sid, false);
      }
      writeCurrent(sid, null);
      refreshSidebarSession(false, sid);
    });
    cleanups.push(unsubError);

    // ── Token Usage ────────────────────────────────────────
    const unsubToken = onTokenUsage((stats, sessionId?: string) => {
      const sid = sessionOf(sessionId);
      if (sid === viewedSession()) {
        set((state) => ({
          tokenUsage: accumulateTokenUsage(state.tokenUsage, stats),
        }));
      } else {
        set((state) => ({
          tokenUsageBySession: {
            ...state.tokenUsageBySession,
            [sid]: accumulateTokenUsage(state.tokenUsageBySession[sid] ?? emptyTokenUsage(), stats),
          },
        }));
      }
    });
    cleanups.push(unsubToken);

    set({ _cleanups: cleanups });
  },

  stopListening: () => {
    // Cancel any scheduled flush and drop buffered blocks so a pending frame
    // callback doesn't fire after teardown.
    for (const sid of pendingBySession.keys()) {
      discardPending(sid);
    }
    pendingBySession.clear();
    const { _cleanups } = get();
    for (const cleanup of _cleanups) {
      cleanup();
    }
    set({ _cleanups: [] });
  },
}));
