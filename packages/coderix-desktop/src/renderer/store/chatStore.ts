import { create } from 'zustand';
import type { ChatMessage } from './types.js';
import { createId } from './types.js';

export interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  sessionId: string | null;
  error: string | null;

  // Actions
  sendMessage: (content: string) => Promise<void>;
  interruptStream: () => void;
  clearMessages: () => void;
  setSessionId: (id: string | null) => void;
  setError: (error: string | null) => void;
}

/**
 * Chat store — manages the chat message list, streaming state, and error state.
 *
 * The `sendMessage` action delegates the actual IPC call to the chat hook
 * (useChat.ts) via an external sender function. This keeps the store
 * decoupled from the IPC layer while providing a consistent interface.
 */
export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  isStreaming: false,
  streamingContent: '',
  sessionId: null,
  error: null,

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
    }));
  },

  interruptStream: () => {
    set({ isStreaming: false, streamingContent: '' });
  },

  clearMessages: () => {
    set({ messages: [], streamingContent: '', error: null });
  },

  setSessionId: (id: string | null) => {
    set({ sessionId: id });
  },

  setError: (error: string | null) => {
    set({ error, isStreaming: false });
  },
}));
