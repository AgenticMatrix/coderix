import { create } from 'zustand';

export type PermissionMode = 'plan' | 'ask' | 'auto';
export type Theme = 'dark' | 'light';

const STANDARD_MODE_KEY = 'coderix-standard-mode';

function loadStandardMode(): boolean {
  try {
    const stored = localStorage.getItem(STANDARD_MODE_KEY);
    // First launch (nothing persisted yet) defaults to standard mode.
    if (stored === null) return true;
    return stored === '1';
  } catch {
    // localStorage unavailable (e.g. strict privacy mode) — default to standard.
    return true;
  }
}

export type NotificationType = 'error' | 'warning' | 'success' | 'info';

export interface AppNotification {
  id: string;
  type: NotificationType;
  message: string;
  detail?: string;
  duration?: number; // ms, default: error=0(sticky), success=3000
}

export interface UIState {
  sidebarOpen: boolean;
  detailPanelOpen: boolean;
  terminalOpen: boolean;
  permissionMode: PermissionMode;
  theme: Theme;
  standardMode: boolean;
  notifications: AppNotification[];
  // Git state (written by GitPanel, read by StatusBar and FileExplorer)
  gitBranch: string;
  gitAhead: number;
  gitBehind: number;
  gitFileStatuses: Record<string, string>; // path → 'modified'|'added'|'deleted'|'untracked'

  // Actions
  toggleSidebar: () => void;
  toggleDetailPanel: () => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setTheme: (theme: Theme) => void;
  toggleStandardMode: () => void;
  addNotification: (n: Omit<AppNotification, 'id'>) => void;
  removeNotification: (id: string) => void;
  setGitBranch: (branch: string, ahead?: number, behind?: number) => void;
  setGitFileStatuses: (statuses: Record<string, string>) => void;
}

/**
 * UI store — manages transient UI state that does not need persistence.
 *
 * All state here is ephemeral — window dimensions, panel visibility,
 * current permission mode, and theme. The theme is synced to the HTML
 * `data-theme` attribute via a side effect in the App shell.
 *
 * Permission modes:
 *   - `plan`: Agent proposes a plan, user approves before execution
 *   - `ask`: Agent asks for each tool permission
 *   - `auto`: Agent auto-executes without asking (use with caution)
 */
export const useUIStore = create<UIState>()((set) => ({
  sidebarOpen: true,
  detailPanelOpen: false,
  terminalOpen: false,
  permissionMode: 'ask',
  theme: 'light',
  standardMode: loadStandardMode(),
  notifications: [],
  gitBranch: '',
  gitAhead: 0,
  gitBehind: 0,
  gitFileStatuses: {},

  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  },

  toggleDetailPanel: () => {
    set((state) => ({ detailPanelOpen: !state.detailPanelOpen }));
  },

  toggleTerminal: () => {
    set((state) => ({ terminalOpen: !state.terminalOpen }));
  },

  setTerminalOpen: (open: boolean) => {
    set({ terminalOpen: open });
  },

  setPermissionMode: (mode: PermissionMode) => {
    set({ permissionMode: mode });
  },

  setTheme: (theme: Theme) => {
    set({ theme });
    // Sync with DOM
    document.documentElement.setAttribute('data-theme', theme);
  },

  toggleStandardMode: () => {
    set((state) => {
      const standardMode = !state.standardMode;
      try {
        localStorage.setItem(STANDARD_MODE_KEY, standardMode ? '1' : '0');
      } catch {
        // localStorage unavailable — keep the in-memory toggle only.
      }
      return { standardMode };
    });
  },

  addNotification: (n) => {
    const id = Math.random().toString(36).slice(2, 9);
    const notification: AppNotification = { ...n, id };
    set((state) => ({ notifications: [...state.notifications, notification] }));
    // Auto-dismiss for non-error notifications
    const duration = n.duration ?? (n.type === 'error' ? 0 : 4000);
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          notifications: state.notifications.filter((x) => x.id !== id),
        }));
      }, duration);
    }
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  setGitBranch: (gitBranch, gitAhead = 0, gitBehind = 0) => {
    set({ gitBranch, gitAhead, gitBehind });
  },

  setGitFileStatuses: (gitFileStatuses) => {
    set({ gitFileStatuses });
  },
}));
