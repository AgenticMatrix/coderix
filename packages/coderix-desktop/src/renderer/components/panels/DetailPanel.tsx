import React, { useState } from 'react';
import { FileText, Plus, RotateCcw, Bot } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useEditorStore, type DiffTab } from '../../store/editorStore.js';
import { EditorPanel } from '../editor/EditorPanel.js';
import { useT } from '../../i18n/index.js';

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

type DiffLineKind = 'add' | 'del' | 'context' | 'meta';

/** Classify a diff body line so it can be colored and numbered. */
function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'meta';
  if (line.startsWith('--- ') || line.startsWith('+++ ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith(' ')) return 'context';
  // diff --git / index / \ No newline ... — headers, not diff lines.
  return 'meta';
}

interface AnnotatedLine {
  line: string;
  kind: DiffLineKind;
  oldNum: number | null;
  newNum: number | null;
}

/** Annotate one hunk's body lines with their old/new-file line numbers. */
function annotateHunk(hunk: Hunk): AnnotatedLine[] {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/.exec(hunk.header);
  let oldNum = m ? parseInt(m[1], 10) : 0;
  let newNum = m ? parseInt(m[2], 10) : 0;
  return hunk.lines.map((line) => {
    const kind = classifyDiffLine(line);
    let o: number | null = null;
    let n: number | null = null;
    if (kind === 'context') {
      o = oldNum++;
      n = newNum++;
    } else if (kind === 'del') {
      o = oldNum++;
    } else if (kind === 'add') {
      n = newNum++;
    }
    return { line, kind, oldNum: o, newNum: n };
  });
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
  const t = useT();
  // Parse hunk headers to get line number ranges: @@ -oldStart,oldCount +newStart,newCount @@
  const hunkRanges = hunks.map(h => {
    const m = h.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    return m ? { oldStart: +m[1], oldCount: +(m[2]||1), newStart: +m[3], newCount: +(m[4]||1) } : null;
  });

  // Build merged lines: content with diff annotations
  const rows: React.ReactNode[] = [];
  rows.push(
    <div key="meta" className="px-3 py-1 text-[10px] text-[var(--color-text-tertiary)] border-b border-[var(--color-separator)]/50">
      {t('detail.linesChanges', { lines: contentLines.length, changes: hunks.length })}
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
              className="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5" style={{ background: 'rgba(76,175,80,0.15)', color: '#4caf50' }}><Plus size={10} /> {t('detail.stage')}</button>
            <button onClick={() => onRevert(hunkIdx)} disabled={stagingHunks.has(hunkIdx)}
              className="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5" style={{ background: 'rgba(244,67,54,0.1)', color: '#f44336' }}><RotateCcw size={10} /> {t('detail.revert')}</button>
          </div>
        </div>
      );

      let newLineOffset = 0;
      let oldLineOffset = 0;
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
          // Removed line — not in new content, show its old-file line number.
          const oldLineNum = range.oldStart + oldLineOffset;
          oldLineOffset++;
          rows.push(
            <div key={`h${hunkIdx}-d-${oldLineOffset}`} className="flex px-3 whitespace-pre" style={{ background: 'rgba(244,67,54,0.08)', color: '#f44336', minHeight: '20px' }}>
              <span className="text-[10px] text-[var(--color-text-tertiary)] select-none w-10 flex-shrink-0 text-right mr-2">{oldLineNum}</span>
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
          oldLineOffset++;
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

/**
 * The single diff view for one changed file (one tab). Owns its own staging /
 * reviewing state so switching diff tabs starts fresh.
 */
function DiffView({ data }: { data: DiffTab }): React.ReactElement {
  const t = useT();
  const [stagingHunks, setStagingHunks] = useState<Set<number>>(new Set());
  const [reviewing, setReviewing] = useState(false);
  const addNotification = useUIStore((s) => s.addNotification);
  const api = (window as any).coderixAPI?.git;
  const fullApi = (window as any).coderixAPI;

  const { meta, hunks } = parseHunks(data.diff);
  const contentLines = data.content ? data.content.split('\n') : null;
  const fileName = data.name || data.path.split('/').pop() || data.path;

  const handleStageHunk = async (index: number) => {
    const patch = buildHunkPatch(meta, hunks[index]);
    const r = await api?.stageHunk(data.path, patch);
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: t('detail.hunkStaged') });
      setStagingHunks(prev => new Set(prev).add(index));
    } else {
      addNotification({ type: 'error', message: t('detail.stageHunkFailed'), detail: r?.error });
    }
  };

  const handleAiReview = async () => {
    if (reviewing || !fullApi?.query?.submit) return;
    setReviewing(true);
    const prompt = `Review this code diff and list any issues (bugs, security, style, logic) concisely:\n\n${data.diff.slice(0, 5000)}`;
    let collected = '';
    const unsub = fullApi.onStreamEvent((evt: any) => {
      if (evt.type === 'blockDelta' && evt.delta) { collected += evt.delta; }
      else if (evt.type === 'done') { unsub(); setReviewing(false); addNotification({ type: 'info', message: t('detail.reviewCompleted') }); }
      else if (evt.type === 'error') { unsub(); setReviewing(false); addNotification({ type: 'error', message: t('detail.reviewFailed'), detail: evt.message }); }
    });
    try { await fullApi.query.submit(prompt); } catch (e) { unsub(); setReviewing(false); }
  };

  const handleRevertHunk = async (index: number) => {
    const patch = buildHunkPatch(meta, hunks[index]);
    const r = await api?.revertHunk(data.path, patch);
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: t('detail.hunkReverted') });
      setStagingHunks(prev => new Set(prev).add(index));
    } else {
      addNotification({ type: 'error', message: t('detail.revertHunkFailed'), detail: r?.error });
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[var(--color-separator)] flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <FileText size={12} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
          <span className="text-xs font-medium truncate">{fileName}</span>
          {hunks.length > 0 && <span className="text-[10px] text-[var(--color-text-tertiary)]">{t('detail.hunks', { n: hunks.length })}</span>}
          <button onClick={handleAiReview} disabled={reviewing}
            className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-1 hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-brand)] disabled:opacity-30 transition-colors"
            title={t('detail.aiReview')}
          ><Bot size={11} /> {t('detail.review')}</button>
        </div>
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
              return (
                <div key={`m-${i}`} className="flex px-3 whitespace-pre" style={{ background: c.bg, color: c.fg, minHeight: '20px' }}>
                  <span className="text-[10px] select-none w-10 flex-shrink-0 text-right mr-2"></span>
                  <span className="flex-1">{line || ' '}</span>
                </div>
              );
            })}
            {hunks.map((hunk, hi) => (
              <div key={`h-${hi}`}>
                <div className="flex items-center group sticky top-0" style={{ background: 'rgba(33,150,243,0.06)' }}>
                  <div className="flex-1 px-3 whitespace-pre" style={{ color: '#2196f3', minHeight: '20px' }}>{hunk.header}</div>
                  <div className="flex-shrink-0 pr-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-0.5">
                    <button onClick={() => handleStageHunk(hi)} disabled={stagingHunks.has(hi)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5" style={{ background: 'rgba(76,175,80,0.15)', color: '#4caf50' }}><Plus size={10} /> {t('detail.stage')}</button>
                    <button onClick={() => handleRevertHunk(hi)} disabled={stagingHunks.has(hi)}
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-0.5" style={{ background: 'rgba(244,67,54,0.1)', color: '#f44336' }}><RotateCcw size={10} /> {t('detail.revert')}</button>
                  </div>
                </div>
                {annotateHunk(hunk).map((al, li) => {
                  const c = lineColor(al.line);
                  // Deleted lines show their old-file number; everything else the new-file number.
                  const num = al.kind === 'del' ? al.oldNum : al.newNum;
                  return (
                    <div key={li} className="flex px-3 whitespace-pre" style={{ background: c.bg, color: c.fg, minHeight: '20px' }}>
                      <span className="text-[10px] text-[var(--color-text-tertiary)] select-none w-10 flex-shrink-0 text-right mr-2">{num ?? ''}</span>
                      <span className="flex-1">{al.line || ' '}</span>
                    </div>
                  );
                })}
              </div>
            ))}
            {hunks.length === 0 && meta.length === 0 && (
              <div className="px-3 py-4 text-center text-[var(--color-text-tertiary)] italic">{t('detail.emptyDiff')}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

DiffView.displayName = 'DiffView';

/**
 * DetailPanel — the right-hand column's body. Renders the active tab: the Monaco
 * editor for a file tab, the merge/diff view for a diff tab, or an empty prompt
 * when nothing is open. Files and diffs coexist as tabs in the same strip.
 */
export function DetailPanel(): React.ReactElement | null {
  const t = useT();
  const { tabs, activeTabId } = useEditorStore();

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  if (!activeTab) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-[var(--color-text-tertiary)]">
        {t('detail.clickToDiff')}
      </div>
    );
  }

  if (activeTab.kind === 'file') {
    return <EditorPanel />;
  }

  return <DiffView key={activeTab.diff.path} data={activeTab.diff} />;
}

DetailPanel.displayName = 'DetailPanel';
