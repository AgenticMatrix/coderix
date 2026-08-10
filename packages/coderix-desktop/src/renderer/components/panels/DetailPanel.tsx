import React, { useState } from 'react';
import { X, FileText, Plus, RotateCcw, Bot } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useEditorStore } from '../../store/editorStore.js';
import { EditorPanel } from '../editor/EditorPanel.js';

export interface DiffData {
  file: string;
  diff: string;
  content?: string; // full file content (from git show <hash>:<file>)
}

interface Hunk {
  header: string;   // @@ line
  lines: string[];  // body lines
}

function parseHunks(diff: string): { meta: string[]; hunks: Hunk[] } {
  const lines = diff.split('\n');
  const meta: string[] = [];
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = { header: line, lines: [] };
    } else if (currentHunk) {
      currentHunk.lines.push(line);
    } else {
      meta.push(line);
    }
  }
  if (currentHunk) hunks.push(currentHunk);
  return { meta, hunks };
}

function buildHunkPatch(meta: string[], hunk: Hunk): string {
  return [...meta, hunk.header, ...hunk.lines].join('\n') + '\n';
}

// MergeView: combines file content lines with diff annotations
function MergeView({ contentLines, hunks, meta, stagingHunks, onStage, onRevert }: {
  contentLines: string[];
  hunks: Hunk[];
  meta: string[];
  stagingHunks: Set<number>;
  onStage: (i: number) => void;
  onRevert: (i: number) => void;
}): React.ReactElement {
  // Parse hunk headers to get line number ranges: @@ -oldStart,oldCount +newStart,newCount @@
  const hunkRanges = hunks.map(h => {
    const m = h.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    return m ? { oldStart: +m[1], oldCount: +(m[2]||1), newStart: +m[3], newCount: +(m[4]||1) } : null;
  });

  // Build merged lines: content with diff annotations
  const rows: React.ReactNode[] = [];
  rows.push(
    <div key="meta" className="px-3 py-1 text-[10px] text-[var(--color-text-tertiary)] border-b border-[var(--color-separator)]/50">
      {contentLines.length} lines · {hunks.length} change{hunks.length !== 1 ? 's' : ''}
    </div>
  );

  let contentIdx = 0; // tracks position in new file content
  let hunkIdx = 0;

  while (contentIdx < contentLines.length || hunkIdx < hunks.length) {
    const range = hunkIdx < hunks.length ? hunkRanges[hunkIdx] : null;
    const hunk = hunkIdx < hunks.length ? hunks[hunkIdx] : null;

    if (range && contentIdx < range.newStart - 1) {
      // Show unchanged content lines before this hunk
      const end = Math.min(range.newStart - 1, contentLines.length);
      while (contentIdx < end) {
        const lineNum = contentIdx + 1;
        const line = contentLines[contentIdx] ?? '';
        rows.push(
          <div key={`c-${contentIdx}`} className="flex px-3 whitespace-pre" style={{ minHeight: '20px' }}>
            <span className="text-[10px] text-[var(--color-text-tertiary)] select-none w-10 flex-shrink-0 text-right mr-2">{lineNum}</span>
            <span className="flex-1">{line || ' '}</span>
          </div>
        );
        contentIdx++;
      }
    } else if (range && hunk) {
      // Show hunk with diff annotations
      rows.push(
        <div key={`hh-${hunkIdx}`} className="flex items-center group sticky top-0 z-10" style={{ background: 'rgba(33,150,243,0.06)' }}>
          <div className="flex-1 px-3 whitespace-pre text-[10px]" style={{ color: '#2196f3', minHeight: '20px' }}>{hunk.header}</div>
          <div className="flex-shrink-0 pr-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5">
            <button onClick={() => onStage(hunkIdx)} disabled={stagingHunks.has(hunkIdx)}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5" style={{ background: 'rgba(76,175,80,0.15)', color: '#4caf50' }}><Plus size={10} /> Stage</button>
            <button onClick={() => onRevert(hunkIdx)} disabled={stagingHunks.has(hunkIdx)}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5" style={{ background: 'rgba(244,67,54,0.1)', color: '#f44336' }}><RotateCcw size={10} /> Revert</button>
          </div>
        </div>
      );

      let newLineOffset = 0;
      for (const line of hunk.lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          // Added line — part of new content
          const lineNum = range.newStart + newLineOffset;
          rows.push(
            <div key={`h${hunkIdx}-a-${newLineOffset}`} className="flex px-3 whitespace-pre" style={{ background: 'rgba(76,175,80,0.08)', color: '#4caf50', minHeight: '20px' }}>
              <span className="text-[10px] text-[var(--color-text-tertiary)] select-none w-10 flex-shrink-0 text-right mr-2">{lineNum}</span>
              <span className="flex-1">{line}</span>
            </div>
          );
          newLineOffset++;
          contentIdx++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          // Removed line — not in new content, show in red without line number
          rows.push(
            <div key={`h${hunkIdx}-d-${newLineOffset}`} className="flex px-3 whitespace-pre" style={{ background: 'rgba(244,67,54,0.08)', color: '#f44336', minHeight: '20px' }}>
              <span className="text-[10px] select-none w-10 flex-shrink-0 text-right mr-2"></span>
              <span className="flex-1">{line}</span>
            </div>
          );
        } else {
          // Context line — unchanged, part of new content
          const lineNum = range.newStart + newLineOffset;
          rows.push(
            <div key={`h${hunkIdx}-c-${newLineOffset}`} className="flex px-3 whitespace-pre" style={{ minHeight: '20px' }}>
              <span className="text-[10px] text-[var(--color-text-tertiary)] select-none w-10 flex-shrink-0 text-right mr-2">{lineNum}</span>
              <span className="flex-1" style={{ color: 'var(--color-text-primary)' }}>{line || ' '}</span>
            </div>
          );
          newLineOffset++;
          contentIdx++;
        }
      }
      hunkIdx++;
    } else {
      // No more hunks, show remaining content
      const lineNum = contentIdx + 1;
      const line = contentLines[contentIdx] ?? '';
      rows.push(
        <div key={`c-${contentIdx}`} className="flex px-3 whitespace-pre" style={{ minHeight: '20px' }}>
          <span className="text-[10px] text-[var(--color-text-tertiary)] select-none w-10 flex-shrink-0 text-right mr-2">{lineNum}</span>
          <span className="flex-1">{line || ' '}</span>
        </div>
      );
      contentIdx++;
    }
  }

  return <>{rows}</>;
}

function lineColor(line: string): { bg: string; fg: string } {
  if (line.startsWith('+') && !line.startsWith('+++'))
    return { bg: 'rgba(76,175,80,0.08)', fg: '#4caf50' };
  if (line.startsWith('-') && !line.startsWith('---'))
    return { bg: 'rgba(244,67,54,0.08)', fg: '#f44336' };
  if (line.startsWith('@@'))
    return { bg: 'rgba(33,150,243,0.06)', fg: '#2196f3' };
  if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++'))
    return { bg: 'transparent', fg: 'var(--color-text-tertiary)' };
  return { bg: 'transparent', fg: 'var(--color-text-primary)' };
}

export function DetailPanel({ data, onClose }: { data?: DiffData | null; onClose?: () => void }): React.ReactElement | null {
  const [stagingHunks, setStagingHunks] = useState<Set<number>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const editorFiles = useEditorStore((s) => s.files);
  const addNotification = useUIStore((s) => s.addNotification);
  const api = (window as any).coderixAPI?.git;
  const fullApi = (window as any).coderixAPI;

  // Show editor when files are open (from main)
  if (editorFiles.length > 0) {
    return <EditorPanel />;
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--color-text-tertiary)]">
        点击文件查看 diff
      </div>
    );
  }

  const { meta, hunks } = parseHunks(data.diff);
  const contentLines = data.content ? data.content.split('\n') : null;
  const fileName = data.file.split('/').pop() ?? data.file;

  const handleStageHunk = async (index: number) => {
    const patch = buildHunkPatch(meta, hunks[index]);
    const r = await api?.stageHunk(data.file, patch);
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: 'Hunk staged' });
      setStagingHunks(prev => new Set(prev).add(index));
    } else {
      addNotification({ type: 'error', message: 'Stage hunk failed', detail: r?.error });
    }
  };

  const handleAiReview = async () => {
    if (reviewing || !fullApi?.query?.submit) return;
    setReviewing(true);
    const prompt = `Review this code diff and list any issues (bugs, security, style, logic) concisely:\n\n${data.diff.slice(0, 5000)}`;
    let collected = '';
    const unsub = fullApi.onStreamEvent((evt: any) => {
      if (evt.type === 'blockDelta' && evt.delta) { collected += evt.delta; }
      else if (evt.type === 'done') { unsub(); setReviewing(false); addNotification({ type: 'info', message: 'Code review completed — check chat' }); }
      else if (evt.type === 'error') { unsub(); setReviewing(false); addNotification({ type: 'error', message: 'Review failed', detail: evt.message }); }
    });
    try { await fullApi.query.submit(prompt); } catch (e) { unsub(); setReviewing(false); }
  };

  const handleRevertHunk = async (index: number) => {
    const patch = buildHunkPatch(meta, hunks[index]);
    const r = await api?.revertHunk(data.file, patch);
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: 'Hunk reverted' });
      setStagingHunks(prev => new Set(prev).add(index));
    } else {
      addNotification({ type: 'error', message: 'Revert hunk failed', detail: r?.error });
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[var(--color-separator)] flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <FileText size={12} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
          <span className="text-xs font-medium truncate">{fileName}</span>
          {hunks.length > 0 && <span className="text-[10px] text-[var(--color-text-tertiary)]">{hunks.length} hunk{hunks.length !== 1 ? 's' : ''}</span>}
          <button onClick={handleAiReview} disabled={reviewing}
            className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-brand)] disabled:opacity-30 transition-colors"
            title="AI Code Review"
          ><Bot size={11} /> Review</button>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]">
            <X size={12} className="text-[var(--color-text-tertiary)]" />
          </button>
        )}
      </div>

      {/* File content + diff (merged view when content is available) */}
      <div className="flex-1 overflow-auto font-mono text-xs leading-5">
        {contentLines ? (
          // Merged view: file content with diff annotations
          <>
            <MergeView contentLines={contentLines} hunks={hunks} meta={meta}
              stagingHunks={stagingHunks}
              onStage={handleStageHunk}
              onRevert={handleRevertHunk}
            />
          </>
        ) : (
          // Diff-only view (working tree changes, no commit content)
          <>
            {meta.map((line, i) => {
              const c = lineColor(line);
              return <div key={`m-${i}`} className="px-3 whitespace-pre" style={{ background: c.bg, color: c.fg, minHeight: '20px' }}>{line || ' '}</div>;
            })}
            {hunks.map((hunk, hi) => (
              <div key={`h-${hi}`}>
                <div className="flex items-center group sticky top-0" style={{ background: 'rgba(33,150,243,0.06)' }}>
                  <div className="flex-1 px-3 whitespace-pre" style={{ color: '#2196f3', minHeight: '20px' }}>{hunk.header}</div>
                  <div className="flex-shrink-0 pr-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5">
                    <button onClick={() => handleStageHunk(hi)} disabled={stagingHunks.has(hi)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5" style={{ background: 'rgba(76,175,80,0.15)', color: '#4caf50' }}><Plus size={10} /> Stage</button>
                    <button onClick={() => handleRevertHunk(hi)} disabled={stagingHunks.has(hi)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5" style={{ background: 'rgba(244,67,54,0.1)', color: '#f44336' }}><RotateCcw size={10} /> Revert</button>
                  </div>
                </div>
                {hunk.lines.map((line, li) => {
                  const c = lineColor(line);
                  return <div key={li} className="px-3 whitespace-pre" style={{ background: c.bg, color: c.fg, minHeight: '20px' }}>{line || ' '}</div>;
                })}
              </div>
            ))}
            {hunks.length === 0 && meta.length === 0 && (
              <div className="px-3 py-4 text-center text-[var(--color-text-tertiary)] italic">Empty diff</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

DetailPanel.displayName = 'DetailPanel';
