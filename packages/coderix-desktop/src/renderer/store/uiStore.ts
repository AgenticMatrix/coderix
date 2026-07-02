import { create } from 'zustand';

export type PermissionMode = 'plan' | 'ask' | 'auto';
export type Theme = 'dark' | 'light';

export interface UIState {
  sidebarOpen: boolean;
  detailPanelOpen: boolean;
  terminalOpen: boolean;
  permissionMode: PermissionMode;
  theme: Theme;

  // Actions
  toggleSidebar: () => void;
  toggleDetailPanel: () => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setTheme: (theme: Theme) => void;
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
}));
