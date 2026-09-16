import React, { useRef, useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useEditorStore } from '../../store/editorStore.js';
import { useT } from '../../i18n/index.js';

export function EditorPanel(): React.ReactElement {
  const t = useT();
  const { files, activeFile } = useEditorStore();
  const editorRef = useRef<any>(null);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const active = files.find(f => f.path === activeFile);

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--color-text-tertiary)]">
        {t('editor.clickToEdit')}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0">
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
  );
}

EditorPanel.displayName = 'EditorPanel';
