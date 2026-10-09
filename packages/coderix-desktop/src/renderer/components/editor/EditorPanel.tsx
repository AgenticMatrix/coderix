import React, { useRef, useCallback, useState, useEffect } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useEditorStore } from '../../store/editorStore.js';
import { Markdown } from '../common/Markdown.js';
import { useT } from '../../i18n/index.js';

/**
 * Monaco editor for the active file tab. Returns null when the active tab is
 * not a file (DetailPanel renders the diff view in that case).
 *
 * Markdown files additionally get a code/preview toggle: "preview" renders the
 * content through the shared Markdown component, "code" opens the raw source
 * in Monaco (still editable).
 */
export function EditorPanel(): React.ReactElement | null {
  const { tabs, activeTabId } = useEditorStore();
  const t = useT();
  const editorRef = useRef<any>(null);
  const [mode, setMode] = useState<'code' | 'preview'>('code');

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const active = activeTab?.kind === 'file' ? activeTab.file : null;

  const activePath = active?.path ?? null;
  const isMarkdown = active?.language === 'markdown';

  // Markdown files open in preview mode; switching files resets the view.
  useEffect(() => {
    setMode(isMarkdown ? 'preview' : 'code');
  }, [activePath, isMarkdown]);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  if (!active) return null;

  const toggleBase =
    'px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors';

  return (
    <div className="h-full min-h-0 flex flex-col">
      {isMarkdown && (
        <div className="flex items-center gap-1 px-2 h-[35px] border-b border-[var(--color-separator)] flex-shrink-0">
          <button
            onClick={() => setMode('preview')}
            className={`${toggleBase} ${
              mode === 'preview'
                ? 'bg-[var(--color-brand-muted)] text-[var(--color-brand)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
            }`}
          >
            {t('editor.preview')}
          </button>
          <button
            onClick={() => setMode('code')}
            className={`${toggleBase} ${
              mode === 'code'
                ? 'bg-[var(--color-brand-muted)] text-[var(--color-brand)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]'
            }`}
          >
            {t('editor.code')}
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {mode === 'preview' ? (
          <div className="h-full overflow-y-auto">
            <Markdown className="max-w-none px-6 py-4 text-[var(--color-text-primary)]">
              {active.content}
            </Markdown>
          </div>
        ) : (
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
