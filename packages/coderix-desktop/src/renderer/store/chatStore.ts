import { create } from 'zustand';
import type { ChatMessage } from './types.js';
import { createId } from './types.js';
import type { ImageAttachment } from '../lib/imageAttachments.js';

export interface ChatState {
  // Viewed-session projection. Components select these; they always reflect the
  // session currently open in the chat pane. Backgrounded sessions live in the
  // per-session maps below.
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  sessionId: string | null;
  error: string | null;
  /** The last turn was stopped by the user and nothing has started since. */
  interrupted: boolean;
  /**
   * The `stop_reason` the engine reported for the last settled turn, shown in
   * the outcome line under the final message. Absent until a turn ends, and
   * cleared when a new one starts so a fresh turn never inherits the previous
   * explanation.
   */
  lastStopReason?: string;

  // Backgrounded sessions' state. A session's transcript is stored here only
  // while it is *not* the viewed session; on switch-in it is popped into the
  // flat `messages`/`isStreaming` above, so there is never a stale duplicate.
  messagesBySession: Record<string, ChatMessage[]>;
  streamingBySession: Record<string, boolean>;
  /**
   * Per-session terminal markers for backgrounded sessions. The viewed session
   * keeps its own copy in the flat `error`/`interrupted` fields above; on switch
   * the flat fields are stashed here and restored, so every row — viewed or not
   * — can feed the same status derivation. Without them a conversation that
   * failed or was stopped lost its badge the moment the user clicked away.
   */
  errorBySession: Record<string, string>;
  interruptedBySession: Record<string, boolean>;
  /**
   * Per-session twin of `lastStopReason`. A backgrounded turn settles while the
   * user is elsewhere, so its ending has to travel with the session or the
   * summary line would describe whichever turn happened to be viewed last.
   */
  stopReasonBySession: Record<string, string>;
  // Per-session stream epoch — bumped on each sendMessage, echoed back by the
  // main process on terminal events (done/error) so a stale turn's late signal
  // can be ignored after an interrupt-and-resend.
  streamEpochBySession: Record<string, number>;

  /**
   * The cursor for loading older history, per session.
   *
   * The chat view renders the *tail* page of a transcript and pages backwards
   * on demand, so a long conversation never loads (or serializes) whole. This
   * holds the oldest message id currently loaded — the exclusive cursor the
   * main process expects — plus whether anything older actually remains.
   * `undefined` means "not known yet" (a live session that never hydrated).
   */
  historyCursorBySession: Record<string, string | undefined>;
  /**
   * Byte offset of `historyCursorBySession`, so the next page seeks to it
   * instead of re-reading the file tail. Purely a seek hint — paging stays
   * correct without it, only slower on deep scrolls.
   */
  historyOffsetBySession: Record<string, number | undefined>;
  hasMoreHistoryBySession: Record<string, boolean>;
  loadingHistoryBySession: Record<string, boolean>;

  /**
   * Whether the viewed transcript is still being read from disk.
   *
   * Distinct from `isStreaming`: opening a conversation is a load, not a turn.
   * The view uses this to hold its empty state instead of flashing "no
   * messages" before the tail page arrives.
   */
  loadingHistory: boolean;

  // Actions
  sendMessage: (content: string, images?: ImageAttachment[]) => Promise<void>;
  interruptStream: (sessionId?: string) => void;
  /** Drop the interrupt marker — a turn that finished on its own wins. */
  clearInterrupted: (sessionId?: string) => void;
  clearMessages: () => void;
  setSessionId: (id: string | null) => boolean;
  setError: (error: string | null) => void;
  /** Route a terminal error to the viewed slot or the session's map slot. */
  setSessionError: (sessionId: string | undefined, error: string | null) => void;
  /** Record why a session's last turn ended (or clear it when a new turn starts). */
  setSessionStopReason: (sessionId: string | undefined, stopReason: string | null) => void;

  /**
   * Install the tail page of a session's transcript, replacing whatever the
   * viewed slot held. Carries the paging cursor so the view knows whether an
   * older page exists.
   */
  setSessionTranscript: (
    sessionId: string,
    messages: ChatMessage[],
    options: { oldestUuid: string | null; oldestOffset?: number | null; hasMore: boolean },
  ) => void;
  /** Prepend one older page and advance the cursor. */
  prependSessionMessages: (
    sessionId: string,
    messages: ChatMessage[],
    options: { oldestUuid: string | null; oldestOffset?: number | null; hasMore: boolean },
  ) => void;
  /** Toggle the "reading history from disk" flag for the viewed session. */
  setLoadingHistory: (loading: boolean) => void;
  /** Toggle the "loading an older page" flag for one session. */
  setLoadingOlderHistory: (sessionId: string, loading: boolean) => void;

  // Per-session routing helpers used by streamStore to land a stream event in
  // the right session (flat when it is the viewed session, else the map).
  commitAssistantMessage: (sessionId: string | undefined, message: ChatMessage) => void;
  patchSessionMessages: (sessionId: string | undefined, updater: (msgs: ChatMessage[]) => ChatMessage[]) => void;
  setSessionStreaming: (sessionId: string | undefined, streaming: boolean) => void;
  /** Adopt the epoch the main process assigned to a submitted turn. */
  setStreamEpoch: (sessionId: string, epoch: number) => void;
}

/** Resolve which session a write targets, falling back to the viewed session. */
function resolveTarget(sessionId: string | undefined, viewed: string | null): string {
  return sessionId ?? viewed ?? '';
}

/**
 * Backgrounded transcripts kept in memory. Opening another session hydrates
 * from disk (`setSessionId` returns false), so dropping an evicted entry only
 * costs a re-read — never data.
 */
const MAX_CACHED_SESSIONS = 2;

function trimSessionCache(
  messagesBySession: Record<string, ChatMessage[]>,
  streamingBySession: Record<string, boolean>,
): Record<string, ChatMessage[]> {
  const keys = Object.keys(messagesBySession);
  let excess = keys.length - MAX_CACHED_SESSIONS;
  if (excess <= 0) return messagesBySession;

  const next = { ...messagesBySession };
  for (const key of keys) {
    if (excess <= 0) break;
    // A live background stream must keep the blocks it is still accumulating.
    if (streamingBySession[key]) continue;
    delete next[key];
    excess--;
  }
  return next;
}

/**
 * Chat store — manages the chat message list, streaming state, and error state.
 *
 * The `sendMessage` action delegates the actual IPC call to the chat hook
 * (useChat.ts) via an external sender function. This keeps the store
 * decoupled from the IPC layer while providing a consistent interface.
 *
 * Per-session model: `messages`/`isStreaming` are the *viewed* session's live
 * state (single source of truth while it is open). When the user switches away,
 * `setSessionId` stashes them into `messagesBySession`/`streamingBySession` and
 * loads the target session's cached state into the flat fields. Concurrent
 * background streams therefore keep accumulating into their map slot and are
 * shown intact when that session is selected again — switching never aborts or
 * discards a running task.
 */
export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  isStreaming: false,
  streamingContent: '',
  sessionId: null,
  error: null,
  interrupted: false,
  messagesBySession: {},
  streamingBySession: {},
  errorBySession: {},
  interruptedBySession: {},
  stopReasonBySession: {},
  streamEpochBySession: {},
  historyCursorBySession: {},
  historyOffsetBySession: {},
  hasMoreHistoryBySession: {},
  loadingHistoryBySession: {},
  loadingHistory: false,

  sendMessage: async (content: string, images?: ImageAttachment[]) => {
    const { sessionId } = get();
    // A message may carry only images — there is no text to require.
    if (!content.trim() && !images?.length) return;

    const text = content.trim();
    const imageBlocks: ChatMessage['blocks'] = (images ?? []).map((img) => ({
      type: 'image' as const,
      state: 'done' as const,
      image: { mediaType: img.mediaType, data: img.data },
    }));

    const userMsg: ChatMessage = {
      id: createId(),
      role: 'user',
      content: text,
      blocks: [
        ...imageBlocks,
        ...(text ? [{ type: 'text' as const, content: text, state: 'done' as const }] : []),
      ],
      ...(images && images.length > 0 ? { images } : {}),
      timestamp: Date.now(),
    };

    set((state) => ({
      messages: [...state.messages, userMsg],
      isStreaming: true,
      error: null,
      interrupted: false,
      // The previous turn's ending no longer describes this session — the new
      // turn will report its own when it settles.
      lastStopReason: undefined,
      streamEpochBySession: sessionId
        ? {
            ...state.streamEpochBySession,
            [sessionId]: (state.streamEpochBySession[sessionId] ?? 0) + 1,
          }
        : state.streamEpochBySession,
    }));
  },

  interruptStream: (sessionId?: string) => {
    const viewed = get().sessionId;
    const target = resolveTarget(sessionId, viewed);
    if (target !== viewed) {
      set((s) => {
        // Mirror the viewed-session rule: only a turn that was still running
        // leaves an "interrupted" marker.
        const wasStreaming = s.streamingBySession[target] === true;
        const streamingBySession = { ...s.streamingBySession, [target]: false };
        const interruptedBySession = { ...s.interruptedBySession };
        if (wasStreaming) interruptedBySession[target] = true;
        else delete interruptedBySession[target];
        return { streamingBySession, interruptedBySession };
      });
      return;
    }
    // Only a live turn can be interrupted. Pressing stop while idle must not
    // leave an "Interrupted" badge on a session that was never running.
    const marker = get().isStreaming || get().interrupted;
    set({ isStreaming: false, streamingContent: '', interrupted: marker });
  },

  clearInterrupted: (sessionId?: string) => {
    const viewed = get().sessionId;
    const target = resolveTarget(sessionId, viewed);
    if (target === viewed) {
      if (get().interrupted) set({ interrupted: false });
      return;
    }
    set((s) => {
      if (!s.interruptedBySession[target]) return s;
      const next = { ...s.interruptedBySession };
      delete next[target];
      return { interruptedBySession: next };
    });
  },

  clearMessages: () => {
    set({ messages: [], streamingContent: '', error: null, interrupted: false });
  },

  setSessionId: (id: string | null) => {
    const state = get();
    const oldId = state.sessionId;
    if (id === oldId) return false;

    // Stash the currently-viewed session's live state into its cache slot.
    let messagesBySession = { ...state.messagesBySession };
    const streamingBySession = { ...state.streamingBySession };
    const errorBySession = { ...state.errorBySession };
    const interruptedBySession = { ...state.interruptedBySession };
    const stopReasonBySession = { ...state.stopReasonBySession };
    if (oldId) {
      // Re-insert so the newest entry sorts last and eviction drops the oldest.
      delete messagesBySession[oldId];
      messagesBySession[oldId] = state.messages;
      streamingBySession[oldId] = state.isStreaming;
      // Terminal markers travel with the session so its row keeps explaining
      // why the last turn ended when the user looks at it from elsewhere.
      if (state.error) errorBySession[oldId] = state.error;
      else delete errorBySession[oldId];
      if (state.interrupted) interruptedBySession[oldId] = true;
      else delete interruptedBySession[oldId];
      if (state.lastStopReason) stopReasonBySession[oldId] = state.lastStopReason;
      else delete stopReasonBySession[oldId];
    }

    // Pop the target's cached transcript (if any) into the viewed slot. A
    // session that was streaming in the background has a map entry; a cold
    // session (never touched this run) does not, and callers use the return
    // value to decide whether to hydrate from disk instead.
    const hadCached = id ? Object.prototype.hasOwnProperty.call(messagesBySession, id) : false;
    const nextMessages = id ? (messagesBySession[id] ?? []) : [];
    const nextStreaming = id ? (streamingBySession[id] ?? false) : false;
    const nextError = id ? (errorBySession[id] ?? null) : null;
    const nextInterrupted = id ? Boolean(interruptedBySession[id]) : false;
    const nextStopReason = id ? stopReasonBySession[id] : undefined;
    // Paging cursors are keyed by session and survive the swap, so returning to
    // a conversation keeps the exact history window the user had scrolled to
    // rather than silently reloading just the tail again.
    const nextCursor = id ? state.historyCursorBySession[id] : undefined;
    const nextOffset = id ? state.historyOffsetBySession[id] : undefined;
    const nextHasMore = id ? (state.hasMoreHistoryBySession[id] ?? false) : false;
    if (id) {
      delete messagesBySession[id];
      delete streamingBySession[id];
      delete errorBySession[id];
      delete interruptedBySession[id];
      delete stopReasonBySession[id];
    }
    messagesBySession = trimSessionCache(messagesBySession, streamingBySession);

    set({
      sessionId: id,
      messages: nextMessages,
      isStreaming: nextStreaming,
      streamingContent: '',
      error: nextError,
      interrupted: nextInterrupted,
      lastStopReason: nextStopReason,
      messagesBySession,
      streamingBySession,
      errorBySession,
      interruptedBySession,
      stopReasonBySession,
      // `loadingHistory` always resets: the view re-reads from disk for a cold
      // session, so it must not inherit a stale spinner from the last one.
      loadingHistory: false,
      hasMoreHistoryBySession: {
        ...state.hasMoreHistoryBySession,
        ...(id ? { [id]: nextHasMore } : {}),
      },
      historyCursorBySession: {
        ...state.historyCursorBySession,
        ...(id ? { [id]: nextCursor } : {}),
      },
      historyOffsetBySession: {
        ...state.historyOffsetBySession,
        ...(id ? { [id]: nextOffset } : {}),
      },
    });
    return hadCached;
  },

  setError: (error: string | null) => {
    set({ error, isStreaming: false, interrupted: false });
  },

  setSessionError: (sessionId, error) => {
    const viewed = get().sessionId;
    const target = resolveTarget(sessionId, viewed);
    if (target === viewed) {
      // Error text only — the turn lifecycle is owned by setSessionStreaming /
      // clearInterrupted, so clearing a stale banner at request-start cannot
      // flip a live turn's streaming flag off.
      if (get().error !== error) set({ error });
      return;
    }
    set((s) => {
      if ((s.errorBySession[target] ?? null) === error) return s;
      const next = { ...s.errorBySession };
      if (error) next[target] = error;
      else delete next[target];
      return { errorBySession: next };
    });
  },

  setSessionStopReason: (sessionId, stopReason) => {
    const viewed = get().sessionId;
    const target = resolveTarget(sessionId, viewed);
    if (target === viewed) {
      if (get().lastStopReason !== (stopReason ?? undefined)) {
        set({ lastStopReason: stopReason ?? undefined });
      }
      return;
    }
    set((s) => {
      const current = s.stopReasonBySession[target];
      if (!stopReason) {
        if (current === undefined) return s;
        const next = { ...s.stopReasonBySession };
        delete next[target];
        return { stopReasonBySession: next };
      }
      if (current === stopReason) return s;
      return { stopReasonBySession: { ...s.stopReasonBySession, [target]: stopReason } };
    });
  },

  commitAssistantMessage: (sessionId, message) => {
    const viewed = get().sessionId;
    const target = resolveTarget(sessionId, viewed);
    if (target === viewed) {
      set((s) => ({
        messages: [...s.messages, message],
        streamingContent: '',
      }));
    } else {
      set((s) => ({
        messagesBySession: trimSessionCache(
          {
            ...s.messagesBySession,
            [target]: [...(s.messagesBySession[target] ?? []), message],
          },
          s.streamingBySession,
        ),
      }));
    }
  },

  patchSessionMessages: (sessionId, updater) => {
    const viewed = get().sessionId;
    const target = resolveTarget(sessionId, viewed);
    if (target === viewed) {
      set((s) => ({ messages: updater(s.messages) }));
    } else {
      set((s) => ({
        messagesBySession: trimSessionCache(
          {
            ...s.messagesBySession,
            [target]: updater(s.messagesBySession[target] ?? []),
          },
          s.streamingBySession,
        ),
      }));
    }
  },

  setSessionStreaming: (sessionId, streaming) => {
    const viewed = get().sessionId;
    const target = resolveTarget(sessionId, viewed);
    if (target === viewed) {
      set({ isStreaming: streaming });
    } else {
      set((s) => ({
        streamingBySession: { ...s.streamingBySession, [target]: streaming },
      }));
    }
  },

  setSessionTranscript: (sessionId, messages, options) => {
    set((s) => ({
      ...(s.sessionId === sessionId
        ? { messages }
        : { messagesBySession: trimSessionCache({ ...s.messagesBySession, [sessionId]: messages }, s.streamingBySession) }),
      historyCursorBySession: { ...s.historyCursorBySession, [sessionId]: options.oldestUuid ?? undefined },
      historyOffsetBySession: { ...s.historyOffsetBySession, [sessionId]: options.oldestOffset ?? undefined },
      hasMoreHistoryBySession: { ...s.hasMoreHistoryBySession, [sessionId]: options.hasMore },
      loadingHistory: false,
      loadingHistoryBySession: { ...s.loadingHistoryBySession, [sessionId]: false },
    }));
  },

  prependSessionMessages: (sessionId, messages, options) => {
    set((s) => {
      const merge = (existing: ChatMessage[]): ChatMessage[] => [...messages, ...existing];
      return {
        ...(s.sessionId === sessionId
          ? { messages: merge(s.messages) }
          : { messagesBySession: trimSessionCache({ ...s.messagesBySession, [sessionId]: merge(s.messagesBySession[sessionId] ?? []) }, s.streamingBySession) }),
        historyCursorBySession: { ...s.historyCursorBySession, [sessionId]: options.oldestUuid ?? undefined },
        historyOffsetBySession: { ...s.historyOffsetBySession, [sessionId]: options.oldestOffset ?? undefined },
        hasMoreHistoryBySession: { ...s.hasMoreHistoryBySession, [sessionId]: options.hasMore },
        loadingHistoryBySession: { ...s.loadingHistoryBySession, [sessionId]: false },
      };
    });
  },

  setLoadingHistory: (loading) => {
    set({ loadingHistory: loading });
  },

  setLoadingOlderHistory: (sessionId, loading) => {
    set((s) =>
      s.loadingHistoryBySession[sessionId] === loading
        ? s
        : { loadingHistoryBySession: { ...s.loadingHistoryBySession, [sessionId]: loading } },
    );
  },

  setStreamEpoch: (sessionId, epoch) => {
    // Exact assignment: the main process owns the counter, so a submit that
    // failed before reaching the engine must not leave the renderer one turn
    // ahead (which would make every following terminal event look stale).
    set((s) =>
      s.streamEpochBySession[sessionId] === epoch
        ? s
        : { streamEpochBySession: { ...s.streamEpochBySession, [sessionId]: epoch } },
    );
  },
}));
