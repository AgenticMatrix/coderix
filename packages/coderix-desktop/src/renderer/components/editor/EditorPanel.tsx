import React, { useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { X } from 'lucide-react';
import { useEditorStore } from '../../store/editorStore.js';

export function EditorPanel(): React.ReactElement {
  const { files, activeFile, setActiveFile, closeFile } = useEditorStore();
  const editorRef = useRef<any>(null);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const active = files.find(f => f.path === activeFile);

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--color-text-tertiary)]">
        点击文件开始编辑
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tabs bar */}
      <div className="flex items-center bg-[var(--color-bg-secondary)] border-b border-[var(--color-separator)] overflow-x-auto flex-shrink-0" style={{ height: '30px' }}>
        {files.map((f) => (
          <div
            key={f.path}
            onClick={() => setActiveFile(f.path)}
            className={`flex items-center gap-1 px-3 h-full cursor-pointer border-r border-[var(--color-separator)] text-xs whitespace-nowrap select-none
              ${f.path === activeFile
                ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] border-t-2 border-t-[var(--color-brand)]'
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

      {/* Editor */}
      <div className="flex-1 min-h-0">
        {active && (
          <Editor
            key={active.path}
            height="100%"
            language={active.language}
            value={active.content}
            onChange={(val) => useEditorStore.getState().updateContent(active.path, val || '')}
            onMount={handleMount}
            theme="vs-dark"
            options={{
              fontSize: 13,
              fontFamily: "'SF Mono', 'JetBrains Mono', 'Fira Code', monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              lineNumbers: 'on',
              renderWhitespace: 'selection',
              tabSize: 2,
              automaticLayout: true,
              readOnly: false,
              padding: { top: 8 },
            }}
          />
        )}
      </div>
    </div>
  );
}

EditorPanel.displayName = 'EditorPanel';
