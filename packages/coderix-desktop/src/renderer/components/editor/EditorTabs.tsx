import React from 'react';
import { X } from 'lucide-react';
import { useEditorStore } from '../../store/editorStore.js';

/**
 * File tab bar — rendered in the header's detail column (not inside the editor
 * panel), mirroring how the browser column's tabs sit at the very top. It reads
 * the same editor store as EditorPanel, so the tabs stay in sync with whichever
 * file is shown below.
 */
export function EditorTabs(): React.ReactElement {
  const { files, activeFile, setActiveFile, closeFile } = useEditorStore();

  if (files.length === 0) {
    return <div className="h-full" />;
  }

  return (
    <div className="h-full flex items-stretch overflow-x-auto">
      {files.map((f) => (
        <div
          key={f.path}
          onClick={() => setActiveFile(f.path)}
          className={`flex items-center gap-1 px-3 h-full cursor-pointer border-r border-[var(--color-separator)] text-xs whitespace-nowrap select-none
            ${f.path === activeFile
              ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] border-b-2 border-b-[var(--color-brand)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'}`}
        >
          <span className="truncate max-w-[140px]">{f.name}</span>
          {f.modified && <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] flex-shrink-0" />}
          <button
            onClick={(e) => { e.stopPropagation(); closeFile(f.path); }}
            className="ml-1 p-0.5 rounded hover:bg-[var(--color-bg-primary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

EditorTabs.displayName = 'EditorTabs';
