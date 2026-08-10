import { create } from 'zustand';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  language: string;
  modified: boolean;
}

interface EditorState {
  files: OpenFile[];
  activeFile: string | null;
  openFile: (file: OpenFile) => void;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
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
  files: [],
  activeFile: null,

  openFile: (file: OpenFile) => {
    const { files } = get();
    const exists = files.find(f => f.path === file.path);
    if (exists) {
      set({ activeFile: file.path });
    } else {
      set({
        files: [...files, { ...file, language: file.language || detectLanguage(file.name) }],
        activeFile: file.path,
      });
    }
  },

  closeFile: (path: string) => {
    const { files, activeFile } = get();
    const updated = files.filter(f => f.path !== path);
    const newActive = activeFile === path
      ? (updated.length > 0 ? updated[updated.length - 1].path : null)
      : activeFile;
    set({ files: updated, activeFile: newActive });
  },

  setActiveFile: (path: string) => set({ activeFile: path }),

  updateContent: (path: string, content: string) => {
    set(state => ({
      files: state.files.map(f => f.path === path ? { ...f, content, modified: true } : f),
    }));
  },
}));
