import { create } from 'zustand';
import type { SessionSummary } from './types.js';
import { listSessions, getSession, forkSession as ipcForkSession, deleteSession as ipcDeleteSession } from '../ipc-client.js';
import { t } from '../i18n/index.js';

export interface SessionState {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  loadSessions: () => Promise<void>;
  refreshSession: (id: string) => Promise<void>;
  bumpSession: (id: string) => void;
  createSession: (opts?: {
    title?: string;
    agentType?: string;
    pluginId?: string;
    skills?: string[];
    mcpServers?: string[];
  }) => Promise<string | undefined>;
  forkSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  /** Patch a conversation's workspace locally, without reloading the list. */
  setSessionWorkDir: (id: string, workDir: string) => void;
  setCurrentSessionId: (id: string | null) => void;
  setError: (error: string | null) => void;
}

/** Raw session shape returned by the main process over IPC. */
type RawSessionInfo = {
  id: string;
  title: string;
  turnCount: number;
  model: string;
  updatedAt: number;
  createdAt: number;
  agentType?: string;
  pluginId?: string;
  workDir?: string;
  busy?: boolean;
  lastUserPreview?: string;
  displayTitle?: string;
  firstUserText?: string;
};

/** Normalize the preload's untyped payload into the renderer's summary shape. */
function normalizeSession(s: RawSessionInfo): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    turnCount: s.turnCount,
    model: s.model,
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
    ...(s.agentType ? { agentType: s.agentType } : {}),
    ...(s.pluginId ? { pluginId: s.pluginId } : {}),
    ...(s.workDir ? { workDir: s.workDir } : {}),
    ...(s.busy ? { busy: true } : {}),
    ...(s.lastUserPreview ? { lastUserPreview: s.lastUserPreview } : {}),
    ...(s.displayTitle ? { displayTitle: s.displayTitle } : {}),
    ...(s.firstUserText ? { firstUserText: s.firstUserText } : {}),
  };
}

/** Keep "most recently updated first" without refetching. */
function sortByRecency(sessions: SessionSummary[]): SessionSummary[] {
  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sessions;
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
    // Wait for preload API to be ready (race condition at startup)
    if (!window.coderixAPI) {
      console.log('[SessionStore] API not ready, retrying in 500ms');
      setTimeout(() => get().loadSessions(), 500);
      set({ isLoading: false });
      return;
    }
    try {
      const sessions = await listSessions();
      const normalized = (sessions as unknown as RawSessionInfo[]).map(normalizeSession);
      set({ sessions: sortByRecency(normalized), isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sessions';
      set({ error: message, isLoading: false });
    }
  },

  refreshSession: async (id: string) => {
    try {
      if (!window.coderixAPI) return;
      const s = await getSession(id);
      if (!s) return;
      const normalized = normalizeSession(s as unknown as RawSessionInfo);
      // Patch the matching entry, or insert it when the conversation is not in
      // the list yet. A full list reload between "session created" and "first
      // message persisted" can drop an in-progress conversation; this upsert
      // guarantees it comes back as soon as a turn has been written.
      set((state) => {
        const exists = state.sessions.some((existing) => existing.id === id);
        const sessions = exists
          ? state.sessions.map((existing) =>
              existing.id === id
                ? {
                    ...normalized,
                    // Never let a briefly-stale disk read revert an optimistic bump.
                    turnCount: Math.max(existing.turnCount, normalized.turnCount),
                  }
                : existing,
            )
          : [normalized, ...state.sessions];
        return { sessions: sortByRecency(sessions) };
      });
    } catch {
      // Best-effort refresh — never disturb the list over a single-session miss.
    }
  },

  bumpSession: (id: string) => {
    // Optimistically reflect a completed turn so the sidebar updates
    // immediately, even before the on-disk summary is readable.
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === id
          ? { ...s, turnCount: s.turnCount + 1, updatedAt: Date.now() }
          : s,
      );
      // Keep "most recently updated first" ordering.
      sessions.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      return { sessions };
    });
  },

  createSession: async (opts) => {
    set({ isLoading: true, error: null });
    try {
      // Use real IPC session creation via preload
      if (!window.coderixAPI) {
        throw new Error('coderixAPI not available');
      }
      const result = await window.coderixAPI.session.create({
        title: opts?.title ?? t('session.newSession'),
        agentType: opts?.agentType,
        pluginId: opts?.pluginId,
        skills: opts?.skills,
        mcpServers: opts?.mcpServers,
      });
      const newSession: SessionSummary = {
        id: result.id,
        title: result.title,
        turnCount: result.turnCount,
        model: '',
        updatedAt: Date.now(),
        createdAt: Date.now(),
        ...(result.agentType ? { agentType: result.agentType } : {}),
        ...(result.pluginId ? { pluginId: result.pluginId } : {}),
        // Persist the session's workspace immediately so the app panel can track
        // the conversation's directory without waiting for a full reload.
        ...(result.cwd ? { workDir: result.cwd } : {}),
      };
      set((state) => ({
        sessions: [newSession, ...state.sessions],
        currentSessionId: result.id,
        isLoading: false,
      }));
      return result.cwd;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      set({ error: message, isLoading: false });
      return undefined;
    }
  },

  forkSession: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await ipcForkSession(id);
      const newSession = result as { id: string; title: string; turnCount?: number };
      set((state) => ({
        sessions: [
          {
            id: newSession.id,
            title: newSession.title ?? `${state.sessions.find((s) => s.id === id)?.title ?? ''} (fork)`,
            // A fork copies the parent's transcript, so it starts with its turns.
            turnCount: newSession.turnCount ?? 0,
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

  setSessionWorkDir: (id: string, workDir: string) => {
    // Workspace switches only change one conversation's directory. Patching it
    // in place keeps the rest of the list (including a just-created session
    // with no transcript file yet) untouched.
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, workDir } : s)),
    }));
  },

  setCurrentSessionId: (id: string | null) => {
    set({ currentSessionId: id });
  },

  setError: (error: string | null) => {
    set({ error });
  },
}));
