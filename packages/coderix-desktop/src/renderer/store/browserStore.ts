import { create } from 'zustand';

/**
 * Browser store — tracks the tabs shown in the embedded browser panel.
 *
 * The actual page content lives in main-process `WebContentsView`s (one per
 * tab); this store only holds the lightweight per-tab metadata (url, title,
 * loading/navigation state) that the renderer's tab bar and address bar need.
 * It survives the panel being closed/reopened so tabs are preserved.
 */

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /** Human-readable load failure (e.g. "net::ERR_NAME_NOT_RESOLVED"), if any. */
  loadError?: string;
}

interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: string | null;
  openTab: (url?: string) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, patch: Partial<BrowserTab>) => void;
}

export const HOME_URL = 'https://www.baidu.com';

let tabCounter = 0;

export const useBrowserStore = create<BrowserState>((set) => ({
  tabs: [],
  activeTabId: null,

  openTab: (url = HOME_URL) => {
    const id = `browser-tab-${++tabCounter}`;
    const tab: BrowserTab = {
      id,
      url,
      title: '',
      canGoBack: false,
      canGoForward: false,
      isLoading: true,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }));
    return id;
  },

  closeTab: (tabId) => {
    set((s) => {
      const next = s.tabs.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        return { tabs: [], activeTabId: null };
      }
      if (s.activeTabId === tabId) {
        const idx = s.tabs.findIndex((t) => t.id === tabId);
        const newActive = next[Math.min(idx, next.length - 1)];
        return { tabs: next, activeTabId: newActive.id };
      }
      return { tabs: next };
    });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  updateTab: (tabId, patch) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
    }));
  },
}));
