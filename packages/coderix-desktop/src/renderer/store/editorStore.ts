import { create } from 'zustand';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  language: string;
  modified: boolean;
}

/** A git diff opened in the detail column (one tab per changed file). */
export interface DiffTab {
  path: string;
  name: string;
  diff: string;
  content?: string;
}

/** A single tab in the detail column: either an editable file or a git diff. */
export type EditorTab =
  | { kind: 'file'; id: string; file: OpenFile }
  | { kind: 'diff'; id: string; diff: DiffTab };

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  openFile: (file: OpenFile) => void;
  openDiff: (diff: DiffTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateContent: (path: string, content: string) => void;
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', css: 'css', scss: 'scss', less: 'less',
    html: 'html', xml: 'xml', svg: 'xml',
    md: 'markdown', mdx: 'markdown',
    py: 'python', rs: 'rust', go: 'go',
    c: 'c', cpp: 'cpp', h: 'c',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', cfg: 'ini',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    dockerfile: 'dockerfile',
    env: 'ini', log: 'plaintext', txt: 'plaintext',
  };
  return map[ext || ''] || 'plaintext';
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openFile: (file) => {
    const id = `file:${file.path}`;
    const { tabs } = get();
    if (tabs.some((t) => t.id === id)) {
      set({ activeTabId: id });
    } else {
      const fileTab: EditorTab = {
        kind: 'file',
        id,
        file: { ...file, language: file.language || detectLanguage(file.name) },
      };
      set({ tabs: [...tabs, fileTab], activeTabId: id });
    }
  },

  openDiff: (diff) => {
    const id = `diff:${diff.path}`;
    const { tabs } = get();
    const diffTab: EditorTab = { kind: 'diff', id, diff };
    if (tabs.some((t) => t.id === id)) {
      // Refresh the diff in place — the working tree may have changed.
      set({ tabs: tabs.map((t) => (t.id === id ? diffTab : t)), activeTabId: id });
    } else {
      set({ tabs: [...tabs, diffTab], activeTabId: id });
    }
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get();
    const updated = tabs.filter((t) => t.id !== id);
    const newActive = activeTabId === id
      ? (updated.length > 0 ? updated[updated.length - 1].id : null)
      : activeTabId;
    set({ tabs: updated, activeTabId: newActive });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  updateContent: (path, content) => {
    set((state) => ({
      tabs: state.tabs.map((t): EditorTab =>
        t.kind === 'file' && t.file.path === path
          ? { ...t, file: { ...t.file, content, modified: true } }
          : t,
      ),
    }));
  },
}));
