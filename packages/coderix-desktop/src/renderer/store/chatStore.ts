import { create } from 'zustand';
import type { ChatMessage } from './types.js';
import { createId } from './types.js';

export interface ChatState {
  // Viewed-session projection. Components select these; they always reflect the
  // session currently open in the chat pane. Backgrounded sessions live in the
  // per-session maps below.
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  sessionId: string | null;
  error: string | null;

  // Backgrounded sessions' state. A session's transcript is stored here only
  // while it is *not* the viewed session; on switch-in it is popped into the
  // flat `messages`/`isStreaming` above, so there is never a stale duplicate.
  messagesBySession: Record<string, ChatMessage[]>;
  streamingBySession: Record<string, boolean>;
  // Per-session stream epoch — bumped on each sendMessage, echoed back by the
  // main process on terminal events (done/error) so a stale turn's late signal
  // can be ignored after an interrupt-and-resend.
  streamEpochBySession: Record<string, number>;

  // Actions
  sendMessage: (content: string) => Promise<void>;
  interruptStream: (sessionId?: string) => void;
  clearMessages: () => void;
  setSessionId: (id: string | null) => boolean;
  setError: (error: string | null) => void;

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
  messagesBySession: {},
  streamingBySession: {},
  streamEpochBySession: {},

  sendMessage: async (content: string) => {
    const { sessionId } = get();
    if (!content.trim()) return;

    const userMsg: ChatMessage = {
      id: createId(),
      role: 'user',
      content: content.trim(),
      blocks: [{ type: 'text', content: content.trim(), state: 'done' }],
      timestamp: Date.now(),
    };

    set((state) => ({
      messages: [...state.messages, userMsg],
      isStreaming: true,
      error: null,
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
      set((s) => ({
        streamingBySession: { ...s.streamingBySession, [target]: false },
      }));
      return;
    }
    set({ isStreaming: false, streamingContent: '' });
  },

  clearMessages: () => {
    set({ messages: [], streamingContent: '', error: null });
  },

  setSessionId: (id: string | null) => {
    const state = get();
    const oldId = state.sessionId;
    if (id === oldId) return false;

    // Stash the currently-viewed session's live state into its cache slot.
    const messagesBySession = { ...state.messagesBySession };
    const streamingBySession = { ...state.streamingBySession };
    if (oldId) {
      messagesBySession[oldId] = state.messages;
      streamingBySession[oldId] = state.isStreaming;
    }

    // Pop the target's cached transcript (if any) into the viewed slot. A
    // session that was streaming in the background has a map entry; a cold
    // session (never touched this run) does not, and callers use the return
    // value to decide whether to hydrate from disk instead.
    const hadCached = id ? Object.prototype.hasOwnProperty.call(messagesBySession, id) : false;
    const nextMessages = id ? (messagesBySession[id] ?? []) : [];
    const nextStreaming = id ? (streamingBySession[id] ?? false) : false;
    if (id) {
      delete messagesBySession[id];
      delete streamingBySession[id];
    }

    set({
      sessionId: id,
      messages: nextMessages,
      isStreaming: nextStreaming,
      streamingContent: '',
      error: null,
      messagesBySession,
      streamingBySession,
    });
    return hadCached;
  },

  setError: (error: string | null) => {
    set({ error, isStreaming: false });
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
        messagesBySession: {
          ...s.messagesBySession,
          [target]: [...(s.messagesBySession[target] ?? []), message],
        },
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
        messagesBySession: {
          ...s.messagesBySession,
          [target]: updater(s.messagesBySession[target] ?? []),
        },
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
