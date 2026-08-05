import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Folder, FolderOpen, File, FileCode, FileText, FileJson } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  gitStatus?: 'modified' | 'added' | 'deleted' | 'untracked';
}

const fileIconMap: Record<string, React.ReactNode> = {
  tsx: <FileCode size={13} className="text-[#409cff]" />,
  ts: <FileCode size={13} className="text-[#409cff]" />,
  js: <FileCode size={13} className="text-[#ff9f0a]" />,
  json: <FileJson size={13} className="text-[#ff9f0a]" />,
  css: <FileCode size={13} className="text-[#5ac8fa]" />,
  md: <FileText size={13} className="text-[var(--color-text-tertiary)]" />,
};

const gitStatusColors: Record<string, string> = {
  modified: 'text-[var(--color-warning)]',
  added: 'text-[var(--color-success)]',
  deleted: 'text-[var(--color-danger)]',
  untracked: 'text-[var(--color-info)]',
};

const gitStatusLabels: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
};

// Mock file tree data
const mockFileTree: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    type: 'directory',
    children: [
      { name: 'App.tsx', path: 'src/App.tsx', type: 'file', gitStatus: 'modified' },
      { name: 'main.tsx', path: 'src/main.tsx', type: 'file' },
      { name: 'types.d.ts', path: 'src/types.d.ts', type: 'file' },
      {
        name: 'components',
        path: 'src/components',
        type: 'directory',
        children: [
          { name: 'ChatView.tsx', path: 'src/components/ChatView.tsx', type: 'file', gitStatus: 'added' },
          { name: 'Sidebar.tsx', path: 'src/components/Sidebar.tsx', type: 'file' },
        ],
      },
      {
        name: 'styles',
        path: 'src/styles',
        type: 'directory',
        children: [
          { name: 'globals.css', path: 'src/styles/globals.css', type: 'file', gitStatus: 'modified' },
        ],
      },
    ],
  },
  {
    name: 'package.json',
    path: 'package.json',
    type: 'file',
  },
  {
    name: 'tsconfig.json',
    path: 'tsconfig.json',
    type: 'file',
  },
];

function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

function getFileIcon(filename: string): React.ReactNode {
  return fileIconMap[getFileExtension(filename)] ?? <File size={13} className="text-[var(--color-text-tertiary)]" />;
}

/** Recursive tree node component */
function TreeNode({ node, depth = 0 }: { node: FileNode; depth?: number }): React.ReactElement {
  const [isOpen, setIsOpen] = useState(depth < 1);
  const hasChildren = node.type === 'directory' && node.children && node.children.length > 0;
  // Resolve git status: explicit on node or from global store
  const gitStatusMap = useUIStore((s) => s.gitFileStatuses);
  const gitStatus = node.gitStatus || (node.type === 'file' ? gitStatusMap[node.path] as FileNode['gitStatus'] : undefined);

  return (
    <div>
      <motion.button
        whileHover={{ backgroundColor: 'var(--color-bg-tertiary)' }}
        whileTap={{ scale: 0.98 }}
        onClick={() => hasChildren && setIsOpen(!isOpen)}
        className={`
          w-full flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer
          transition-colors duration-50 hover:bg-[var(--color-bg-tertiary)]
          ${depth > 0 ? '' : 'font-medium'}
        `}
        style={{ paddingLeft: 8 + depth * 16 }}
      >
        {/* Expand/collapse arrow */}
        {node.type === 'directory' && (
          <motion.span
            animate={{ rotate: isOpen ? 90 : 0 }}
            transition={{ duration: 0.15 }}
            className="flex-shrink-0 text-[var(--color-text-tertiary)]"
          >
            <ChevronRight size={12} />
          </motion.span>
        )}
        {node.type === 'file' && <span className="w-3 flex-shrink-0" />}

        {/* Icon */}
        {node.type === 'directory' ? (
          isOpen ? (
            <FolderOpen size={13} className="text-[var(--color-info)] flex-shrink-0" />
          ) : (
            <Folder size={13} className="text-[var(--color-info)] flex-shrink-0" />
          )
        ) : (
          getFileIcon(node.name)
        )}

        {/* Name */}
        <span className="truncate text-[var(--color-text-primary)]">{node.name}</span>

        {/* Git status */}
        {gitStatus && (
          <span className={`ml-auto text-[10px] font-mono font-bold ${gitStatusColors[gitStatus]}`}>
            {gitStatusLabels[gitStatus]}
          </span>
        )}
      </motion.button>

      {/* Children */}
      <AnimatePresence>
        {isOpen && hasChildren && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            {node.children!.map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export interface FileExplorerProps {
  /** Optional — file tree data, defaults to mock */
  fileTree?: FileNode[];
}

export function FileExplorer({ fileTree = mockFileTree }: FileExplorerProps): React.ReactElement {
  return (
    <div className="py-1">
      {fileTree.map((node) => (
        <TreeNode key={node.path} node={node} />
      ))}
    </div>
  );
}

FileExplorer.displayName = 'FileExplorer';

export type { FileNode };
