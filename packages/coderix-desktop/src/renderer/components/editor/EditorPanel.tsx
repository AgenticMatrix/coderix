import React, { useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useEditorStore } from '../../store/editorStore.js';

/**
 * Monaco editor for the active file tab. Returns null when the active tab is
 * not a file (DetailPanel renders the diff view in that case).
 */
export function EditorPanel(): React.ReactElement | null {
  const { tabs, activeTabId } = useEditorStore();
  const editorRef = useRef<any>(null);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const active = activeTab?.kind === 'file' ? activeTab.file : null;
  if (!active) return null;

  return (
    <div className="h-full min-h-0">
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
    </div>
  );
}

EditorPanel.displayName = 'EditorPanel';
