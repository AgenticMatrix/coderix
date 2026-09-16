import React from 'react';
import { X } from 'lucide-react';
import { useEditorStore } from '../../store/editorStore.js';

/**
 * Detail-column tab bar — one tab per open item, mixing editable files and git
 * diffs in a single strip. Rendered in the header (not inside the detail panel)
 * so it mirrors the browser column's tab bar. Reads the same editor store as
 * DetailPanel/EditorPanel, so tabs stay in sync with the content below.
 */
export function EditorTabs(): React.ReactElement {
  const { tabs, activeTabId, setActiveTab, closeTab } = useEditorStore();

  if (tabs.length === 0) {
    return <div className="h-full" />;
  }

  return (
    <div className="h-full flex items-stretch overflow-x-auto">
      {tabs.map((tab) => {
        const isDiff = tab.kind === 'diff';
        const name = isDiff ? tab.diff.name : tab.file.name;
        const modified = !isDiff && tab.file.modified;
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1 px-3 h-full cursor-pointer border-r border-[var(--color-separator)] text-xs whitespace-nowrap select-none
              ${active
                ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] border-b-2 border-b-[var(--color-brand)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'}`}
          >
            {isDiff && <span className="w-1.5 h-1.5 rounded-full bg-[#e2b714] flex-shrink-0" title="diff" />}
            <span className="truncate max-w-[140px]">{name}</span>
            {modified && <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] flex-shrink-0" />}
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              className="ml-1 p-0.5 rounded hover:bg-[var(--color-bg-primary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

EditorTabs.displayName = 'EditorTabs';
