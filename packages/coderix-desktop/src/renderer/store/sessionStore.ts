import { create } from 'zustand';
import type { SessionSummary } from './types.js';
import { listSessions, forkSession as ipcForkSession, deleteSession as ipcDeleteSession } from '../ipc-client.js';

export interface SessionState {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadSessions: () => Promise<void>;
  createSession: () => Promise<void>;
  forkSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setCurrentSessionId: (id: string | null) => void;
  setError: (error: string | null) => void;
}

/**
 * Session store — manages the list of chat sessions and the currently active one.
 *
 * Each action calls the preload API via window.coderixAPI to perform CRUD
 * operations on sessions. The store handles optimistic-ui patterns where
 * appropriate (e.g., removing from the list before the server confirms).
 */
export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  currentSessionId: null,
  isLoading: false,
  error: null,

  loadSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const sessions = await listSessions();
      // Normalize: the preload returns unknown, but we expect SessionInfo[]
      const normalized: SessionSummary[] = (sessions as unknown as Array<{
        id: string;
        title: string;
        turnCount: number;
        model: string;
        updatedAt: number;
        createdAt: number;
      }>).map((s) => ({
        id: s.id,
        title: s.title,
        turnCount: s.turnCount,
        model: s.model,
        updatedAt: s.updatedAt,
        createdAt: s.createdAt,
      }));
      set({ sessions: normalized, isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sessions';
      set({ error: message, isLoading: false });
    }
  },

  createSession: async () => {
    set({ isLoading: true, error: null });
    try {
      // The preload API does not have a direct createSession call.
      // In practice, creating a session is done by starting a new conversation.
      // We generate a client-side ID and set it as current.
      const newId = `session-${Date.now()}`;
      const newSession: SessionSummary = {
        id: newId,
        title: '新对话',
        turnCount: 0,
        model: '',
        updatedAt: Date.now(),
        createdAt: Date.now(),
      };
      set((state) => ({
        sessions: [newSession, ...state.sessions],
        currentSessionId: newId,
        isLoading: false,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      set({ error: message, isLoading: false });
    }
  },

  forkSession: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await ipcForkSession(id);
      const newSession = result as { id: string; title: string };
      set((state) => ({
        sessions: [
          {
            id: newSession.id,
            title: newSession.title ?? `${state.sessions.find((s) => s.id === id)?.title ?? ''} (fork)`,
            turnCount: 0,
            model: '',
            updatedAt: Date.now(),
            createdAt: Date.now(),
          },
          ...state.sessions,
        ],
        currentSessionId: newSession.id,
        isLoading: false,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fork session';
      set({ error: message, isLoading: false });
    }
  },

  deleteSession: async (id: string) => {
    // Optimistic removal
    const prevSessions = get().sessions;
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      currentSessionId: state.currentSessionId === id ? null : state.currentSessionId,
    }));

    try {
      await ipcDeleteSession(id);
    } catch (err) {
      // Rollback on failure
      const message = err instanceof Error ? err.message : 'Failed to delete session';
      set({ sessions: prevSessions, error: message });
    }
  },

  setCurrentSessionId: (id: string | null) => {
    set({ currentSessionId: id });
  },

  setError: (error: string | null) => {
    set({ error });
  },
}));
