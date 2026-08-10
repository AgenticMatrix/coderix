import React from 'react';
import { X, FileText } from 'lucide-react';
import { useEditorStore } from '../../store/editorStore.js';
import { EditorPanel } from '../editor/EditorPanel.js';

export interface DiffData {
  file: string;
  diff: string;
}

export function DetailPanel({ data, onClose }: { data?: DiffData | null; onClose?: () => void }): React.ReactElement | null {
  const editorFiles = useEditorStore((s) => s.files);

  // Show editor when files are open (even if diff data is present)
  if (editorFiles.length > 0) {
    return <EditorPanel />;
  }

  // Show diff viewer
  if (data) {
    return <DiffView data={data} onClose={onClose} />;
  }

  // Empty state
  return (
    <div className="flex items-center justify-center h-full text-xs text-[var(--color-text-tertiary)]">
      点击文件查看
    </div>
  );
}

DetailPanel.displayName = 'DetailPanel';

// ── Diff view (moved from original DetailPanel) ──

function DiffView({ data, onClose }: { data: DiffData; onClose?: () => void }): React.ReactElement {
  const lines = data.diff.split('\n');
  const fileName = data.file.split('/').pop() ?? data.file;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[var(--color-separator)] flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <FileText size={12} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
          <span className="text-xs font-medium truncate">{fileName}</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]">
            <X size={12} className="text-[var(--color-text-tertiary)]" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto font-mono text-xs leading-5">
        {lines.map((line, i) => {
          let bg = 'transparent';
          let fg = 'var(--color-text-primary)';
          if (line.startsWith('+') && !line.startsWith('+++')) {
            bg = 'rgba(76,175,80,0.08)'; fg = '#4caf50';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            bg = 'rgba(244,67,54,0.08)'; fg = '#f44336';
          } else if (line.startsWith('@@')) {
            bg = 'rgba(33,150,243,0.06)'; fg = '#2196f3';
          } else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
            fg = 'var(--color-text-tertiary)';
          }
          return (
            <div key={i} className="px-3 whitespace-pre" style={{ background: bg, color: fg, minHeight: '20px' }}>
              {line || ' '}
            </div>
          );
        })}
      </div>
    </div>
  );
}
