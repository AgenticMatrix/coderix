import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Folder, FolderOpen, File, FileCode, FileText, FileJson, FileImage, FileType, Cog, Globe, Terminal, Package } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  gitStatus?: 'modified' | 'added' | 'deleted' | 'untracked';
}

// VS Code-inspired file icon colors — keyed by file extension
const FILE_ICON_COLORS: Record<string, { color: string; icon: React.ReactNode }> = {
  // ── TypeScript / JavaScript ──
  tsx:   { color: '#3178c6', icon: <FileCode size={13} /> },
  ts:    { color: '#3178c6', icon: <FileCode size={13} /> },
  jsx:   { color: '#f0db4f', icon: <FileCode size={13} /> },
  js:    { color: '#f0db4f', icon: <FileCode size={13} /> },
  mjs:   { color: '#f0db4f', icon: <FileCode size={13} /> },
  cjs:   { color: '#f0db4f', icon: <FileCode size={13} /> },
  dts:   { color: '#3178c6', icon: <FileCode size={13} /> },
  // ── Styles ──
  css:   { color: '#42a5f5', icon: <FileCode size={13} /> },
  scss:  { color: '#cf649a', icon: <FileCode size={13} /> },
  less:  { color: '#1d6eaa', icon: <FileCode size={13} /> },
  // ── Markup / Data ──
  json:  { color: '#cbcb41', icon: <FileJson size={13} /> },
  html:  { color: '#e44d26', icon: <Globe size={13} /> },
  xml:   { color: '#e44d26', icon: <Globe size={13} /> },
  svg:   { color: '#ff9800', icon: <FileImage size={13} /> },
  md:    { color: '#42a5f5', icon: <FileText size={13} /> },
  mdx:   { color: '#42a5f5', icon: <FileText size={13} /> },
  // ── YAML / Config ──
  yaml:  { color: '#cb171e', icon: <Cog size={13} /> },
  yml:   { color: '#cb171e', icon: <Cog size={13} /> },
  toml:  { color: '#9c9c9c', icon: <Cog size={13} /> },
  cfg:   { color: '#9c9c9c', icon: <Cog size={13} /> },
  ini:   { color: '#9c9c9c', icon: <Cog size={13} /> },
  rc:    { color: '#9c9c9c', icon: <Cog size={13} /> },
  // ── Shell / Scripts ──
  sh:    { color: '#4ec921', icon: <Terminal size={13} /> },
  bash:  { color: '#4ec921', icon: <Terminal size={13} /> },
  zsh:   { color: '#4ec921', icon: <Terminal size={13} /> },
  fish:  { color: '#4ec921', icon: <Terminal size={13} /> },
  ps1:   { color: '#4ec921', icon: <Terminal size={13} /> },
  // ── Python ──
  py:    { color: '#3572A5', icon: <FileCode size={13} /> },
  pyi:   { color: '#3572A5', icon: <FileCode size={13} /> },
  // ── Rust / Go / C/C++ ──
  rs:    { color: '#dea584', icon: <FileCode size={13} /> },
  go:    { color: '#00ADD8', icon: <FileCode size={13} /> },
  c:     { color: '#555',    icon: <FileCode size={13} /> },
  cpp:   { color: '#6195cb', icon: <FileCode size={13} /> },
  h:     { color: '#6195cb', icon: <FileCode size={13} /> },
  hpp:   { color: '#6195cb', icon: <FileCode size={13} /> },
  // ── Package / Lock files ──
  lock:  { color: '#9c9c9c', icon: <Package size={13} /> },
  // ── Docker / Makefile ──
  dockerfile: { color: '#0db7ed', icon: <Package size={13} /> },
  mk:    { color: '#9c9c9c', icon: <Cog size={13} /> },
  // ── Misc ──
  log:   { color: '#9c9c9c', icon: <FileText size={13} /> },
  txt:   { color: '#9c9c9c', icon: <FileText size={13} /> },
  env:   { color: '#fbc02d', icon: <Cog size={13} /> },
  sql:   { color: '#cf649a', icon: <FileCode size={13} /> },
  graphql: { color: '#e10098', icon: <FileCode size={13} /> },
  gql:   { color: '#e10098', icon: <FileCode size={13} /> },
  proto: { color: '#f44336', icon: <FileCode size={13} /> },
  prisma:{ color: '#0c344b', icon: <FileCode size={13} /> },
  // Fonts
  ttf:   { color: '#e91e63', icon: <FileType size={13} /> },
  woff:  { color: '#e91e63', icon: <FileType size={13} /> },
  woff2: { color: '#e91e63', icon: <FileType size={13} /> },
  eot:   { color: '#e91e63', icon: <FileType size={13} /> },
  // Images
  png:   { color: '#9c27b0', icon: <FileImage size={13} /> },
  jpg:   { color: '#9c27b0', icon: <FileImage size={13} /> },
  jpeg:  { color: '#9c27b0', icon: <FileImage size={13} /> },
  gif:   { color: '#9c27b0', icon: <FileImage size={13} /> },
  webp:  { color: '#9c27b0', icon: <FileImage size={13} /> },
  ico:   { color: '#9c27b0', icon: <FileImage size={13} /> },
};

const gitStatusColors: Record<string, string> = {
  modified: 'text-[var(--color-warning)]', added: 'text-[var(--color-success)]',
  deleted: 'text-[var(--color-danger)]', untracked: 'text-[var(--color-info)]',
};
const gitStatusLabels: Record<string, string> = {
  modified: 'M', added: 'A', deleted: 'D', untracked: 'U',
};

function getFileExtension(filename: string): string {
  const name = filename.toLowerCase();
  // Special filenames without extensions
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'mk';
  const parts = filename.split('.');
  if (parts.length <= 1) return '';
  // Handle double extensions: .d.ts → ts, .test.ts → ts
  if (parts[parts.length - 1] === 'ts' && parts[parts.length - 2] === 'd') return 'dts';
  return parts[parts.length - 1].toLowerCase();
}

function getFileIcon(filename: string): React.ReactNode {
  const ext = getFileExtension(filename);
  const cfg = FILE_ICON_COLORS[ext];
  if (cfg) return <span style={{ color: cfg.color }}>{cfg.icon}</span>;
  // Default: subtle file icon
  return <File size={13} className="text-[var(--color-text-tertiary)]" />;
}

// ── Recursive tree node ────────────────────────────

function TreeNode({ node, depth = 0, onToggle, onFileClick }: {
  node: FileNode; depth?: number; onToggle?: (node: FileNode) => void;
  onFileClick?: (node: FileNode) => void;
}): React.ReactElement {
  const [isOpen, setIsOpen] = useState(depth < 1);
  const hasChildren = node.type === 'directory';
  const gitStatusMap = useUIStore((s) => s.gitFileStatuses);
  const resolvedStatus = node.gitStatus || (node.type === 'file' ? gitStatusMap[node.path] as FileNode['gitStatus'] : undefined);

  const handleClick = () => {
    if (hasChildren) {
      setIsOpen(!isOpen);
      if (!isOpen && onToggle) onToggle(node);
    } else {
      onFileClick?.(node);
    }
  };

  return (
    <div>
      <motion.button
        whileHover={{ backgroundColor: 'var(--color-bg-tertiary)' }}
        whileTap={{ scale: 0.98 }}
        onClick={handleClick}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer transition-colors duration-50 hover:bg-[var(--color-bg-tertiary)] ${depth > 0 ? '' : 'font-medium'}`}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {node.type === 'directory' && (
          <motion.span animate={{ rotate: isOpen ? 90 : 0 }} transition={{ duration: 0.15 }} className="flex-shrink-0 text-[var(--color-text-tertiary)]">
            <ChevronRight size={12} />
          </motion.span>
        )}
        {node.type === 'file' && <span className="w-3 flex-shrink-0" />}
        {node.type === 'directory'
          ? (isOpen ? <FolderOpen size={13} className="text-[var(--color-info)] flex-shrink-0" /> : <Folder size={13} className="text-[var(--color-info)] flex-shrink-0" />)
          : getFileIcon(node.name)}
        <span className="truncate text-[var(--color-text-primary)]">{node.name}</span>
        {resolvedStatus && (
          <span className={`ml-auto text-[10px] font-mono font-bold ${gitStatusColors[resolvedStatus]}`}>
            {gitStatusLabels[resolvedStatus]}
          </span>
        )}
      </motion.button>

      <AnimatePresence>
        {isOpen && node.children && node.children.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15, ease: 'easeOut' }}>
            {node.children.map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} onToggle={onToggle} onFileClick={onFileClick} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main component ─────────────────────────────────

export interface FileExplorerProps {
  fileTree?: FileNode[];
  projectPath?: string;
}

export function FileExplorer({ fileTree, projectPath }: FileExplorerProps): React.ReactElement {
  const [tree, setTree] = useState<FileNode[]>(fileTree ?? []);
  const [loading, setLoading] = useState(!fileTree);

  const loadDir = useCallback(async (dirPath: string, parentNode?: FileNode) => {
    const api = window.coderixAPI?.fs;
    if (!api) return;
    try {
      const result = await api.listDir(dirPath);
      if (!result?.entries) return;
      const nodes: FileNode[] = result.entries
        .filter((e: any) => !e.name?.startsWith('.') || e.name === '.gitignore') // skip dotfiles
        .sort((a: any, b: any) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return (a.name || '').localeCompare(b.name || '');
        })
        .map((e: any) => ({
          name: e.name,
          path: dirPath ? `${dirPath}/${e.name}` : e.name,
          type: e.isDirectory ? 'directory' as const : 'file' as const,
          children: e.isDirectory ? [] : undefined,
        }));

      if (parentNode) {
        parentNode.children = nodes;
        setTree((prev) => [...prev]);
      } else {
        setTree(nodes);
      }
    } catch { /* fs access error */ }
  }, []);

  // Load root on first mount if no fileTree provided
  useEffect(() => {
    if (!fileTree) {
      setLoading(true);
      loadDir('').finally(() => setLoading(false));
    } else {
      setTree(fileTree);
      setLoading(false);
    }
  }, [fileTree, loadDir, projectPath]);

  const handleToggle = useCallback((node: FileNode) => {
    if (node.children && node.children.length === 0) {
      loadDir(node.path, node);
    }
  }, [loadDir]);

  const handleFileClick = useCallback(async (node: FileNode) => {
    const api = window.coderixAPI?.fs;
    if (!api) return;
    try {
      const result = await api.readFile(node.path);
      if (result?.content) {
        window.dispatchEvent(new CustomEvent('coderix:open-file', {
          detail: { path: node.path, name: node.name, content: result.content },
        }));
      }
    } catch { /* file read error */ }
  }, []);

  // Merge git status from git:status IPC
  useEffect(() => {
    const api = window.coderixAPI?.git;
    if (!api) return;
    api.status().then((s) => {
      if (!s?.files?.length) return;
      const statusMap = new Map(s.files.map((f: any) => [f.file, f.type]));
      const applyStatus = (nodes: FileNode[]): FileNode[] => {
        for (const n of nodes) {
          const gitType = statusMap.get(n.path);
          if (gitType) n.gitStatus = gitType as FileNode['gitStatus'];
          if (n.children) applyStatus(n.children);
        }
        return nodes;
      };
      setTree((prev) => [...applyStatus([...prev])]);
    }).catch(() => {});
  }, [projectPath]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className="p-4 text-xs text-center text-[var(--color-text-tertiary)]">Loading files...</div>;
  }

  return (
    <div className="py-1">
      {tree.length === 0 ? (
        <div className="p-4 text-xs text-center text-[var(--color-text-tertiary)]">No files found</div>
      ) : (
        tree.map((node) => (
          <TreeNode key={node.path} node={node} onToggle={handleToggle} onFileClick={handleFileClick} />
        ))
      )}
    </div>
  );
}

FileExplorer.displayName = 'FileExplorer';
export type { FileNode };
