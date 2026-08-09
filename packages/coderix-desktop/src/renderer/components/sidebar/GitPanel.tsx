import React, { useEffect, useState, useCallback } from 'react';
import { GitBranch, RefreshCw, Check, ChevronRight, ChevronDown, Ellipsis } from 'lucide-react';

interface GitFile { file: string; type: string; code: string; }
interface GitCommit { hash: string; message: string; graph?: string; refs?: string; }
interface ShowData { diff: string; files: Array<{ file: string; type: string }>; }

const TYPE_CFG: Record<string, { label: string; color: string }> = {
  M: { label: 'M', color: '#e2b714' }, A: { label: 'A', color: '#4caf50' },
  D: { label: 'D', color: '#f44336' }, R: { label: 'R', color: '#2196f3' },
  '?': { label: 'U', color: '#4caf50' },
};

// Branch colors for graph lines (cycling palette)
const BRANCH_COLORS = [
  '#2196f3', '#4caf50', '#ff9800', '#e91e63', '#9c27b0',
  '#00bcd4', '#795548', '#607d8b', '#cddc39', '#ff5722',
];

export function GitPanel({ onFileSelect, projectPath }: { onFileSelect?: (file: string, diff: string) => void; projectPath?: string }): React.ReactElement {
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<GitFile[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [commitMsg, setCommitMsg] = useState('');
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<ShowData | null>(null);
  const [loadingCommit, setLoadingCommit] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(true);

  function emitDiff(file: string, diff: string) {
  window.dispatchEvent(new CustomEvent('coderix:open-diff', { detail: { file, diff } }));
}

const api = window.coderixAPI?.git;

  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const s = await api.status();
      setBranch(s.branch);
      setFiles(s.files || []);
      setCommits(s.commits || []);
    } catch { /* git not available */ }
    setLoading(false);
  }, [api]);

  useEffect(() => { load(); }, [load, projectPath]);

  const handleCommit = useCallback(async () => {
    if (!api || !commitMsg.trim()) return;
    await api.commit(commitMsg.trim());
    setCommitMsg('');
    load();
  }, [api, commitMsg, load]);

  const handleStage = useCallback(async (file: string) => { await api?.stage(file); load(); }, [api, load]);
  const handleUnstage = useCallback(async (file: string) => { await api?.unstage(file); load(); }, [api, load]);
  const handleStageAll = useCallback(async () => { await api?.stage(undefined, true); load(); }, [api, load]);
  const handleUnstageAll = useCallback(async () => { await api?.unstage(undefined, true); load(); }, [api, load]);

  const handleViewDiff = useCallback(async (file: string, staged?: boolean) => {
    if (!api) return;
    const r = await api.diff(file, staged);
    if (r.diff) emitDiff(file, r.diff);
  }, [api]);

  const handleExpandCommit = useCallback(async (hash: string) => {
    if (expandedCommit === hash) { setExpandedCommit(null); return; }
    setExpandedCommit(hash);
    setLoadingCommit(true);
    try {
      const r = await api?.show(hash);
      setCommitDetail(r || null);
    } catch { setCommitDetail(null); }
    setLoadingCommit(false);
  }, [api, expandedCommit]);

  const staged = files.filter(f => f.code[0] !== ' ' && f.code[0] !== '?');
  const unstaged = files.filter(f => f.code[1] !== ' ' || f.code[0] === '?');

  if (loading) {
    return <div className="flex flex-col h-full text-xs"><div className="p-4 text-center text-[var(--color-text-tertiary)]">Loading...</div></div>;
  }

  return (
    <div className="flex flex-col h-full text-xs">
      {/* ── Header bar ────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[var(--color-separator)] flex-shrink-0">
        <span className="font-semibold text-[11px] text-[var(--color-text-secondary)] uppercase tracking-wide">Source Control</span>
        <div className="flex items-center gap-0.5">
          <button onClick={load} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]" title="Refresh"><RefreshCw size={12} /></button>
          <button className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]" title="More"><Ellipsis size={12} /></button>
        </div>
      </div>

      {/* ── Commit message input ───────────────────────── */}
      <div className="px-3 py-2 border-b border-[var(--color-separator)] flex-shrink-0">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Message (⌘Enter to commit)"
            className="flex-1 h-7 px-2 rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-input-bg)] text-[var(--color-text-primary)] text-xs outline-none"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleCommit(); }}
          />
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim() || (staged.length === 0 && unstaged.length === 0)}
            className="h-7 w-7 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-white disabled:opacity-30 flex items-center justify-center flex-shrink-0"
            title="Commit (⌘Enter)"
          >
            <Check size={14} strokeWidth={2.5} />
          </button>
        </div>
        {/* Branch indicator — always visible */}
        <div className="flex items-center gap-1 mt-1.5 text-[10px] text-[var(--color-text-secondary)]">
          <GitBranch size={10} />
          <span className="font-mono">{branch || '...'}</span>
          {files.length > 0 && (
            <span className="text-[var(--color-text-tertiary)] ml-1">· {files.length} file{files.length !== 1 ? 's' : ''}</span>
          )}
        </div>
      </div>

      {/* ── Scrollable file list ────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {/* ── Staged Changes ──────────────────────────── */}
        <SectionHeader
          title="Staged Changes"
          count={staged.length}
          open={stagedOpen}
          onToggle={() => setStagedOpen(!stagedOpen)}
          actions={staged.length > 0 ? [{ label: 'Unstage All', onClick: handleUnstageAll }] : []}
        />
        {stagedOpen && staged.map((f, i) => (
          <FileRow key={`s-${i}`} file={f} onClick={() => handleViewDiff(f.file, true)} actionLabel="−" actionTitle="Unstage" onAction={() => handleUnstage(f.file)} />
        ))}

        {/* ── Changes (unstaged) ──────────────────────── */}
        <SectionHeader
          title="Changes"
          count={unstaged.length}
          open={changesOpen}
          onToggle={() => setChangesOpen(!changesOpen)}
          actions={unstaged.length > 0 ? [{ label: 'Stage All', onClick: handleStageAll }] : []}
        />
        {changesOpen && (unstaged.length === 0 ? (
          <div className="px-5 py-4 text-center text-[var(--color-text-tertiary)] italic">No changes</div>
        ) : (
          unstaged.map((f, i) => (
            <FileRow key={`u-${i}`} file={f} onClick={() => handleViewDiff(f.file)} actionLabel="＋" actionTitle="Stage" onAction={() => handleStage(f.file)} />
          ))
        ))}

        {/* ── Commits (with graph) ──────────────────── */}
        <SectionHeader
          title="Commits"
          count={commits.length}
          open={commitsOpen}
          onToggle={() => setCommitsOpen(!commitsOpen)}
        />
        {commitsOpen && commits.map((c, idx) => {
          const isOpen = expandedCommit === c.hash;
          return (
            <div key={c.hash}>
              <div
                className="pr-2 hover:bg-[var(--color-bg-tertiary)] cursor-pointer flex items-center gap-1"
                onClick={() => handleExpandCommit(c.hash)}
                style={{ paddingLeft: '2px', lineHeight: '16px', minHeight: '16px' }}
              >
                {/* Graph visualization */}
                <span className="font-mono text-[11px] leading-none flex-shrink-0" style={{ width: '60px', whiteSpace: 'pre' }}>
                  {c.graph ? renderGraph(c.graph) : ''}
                </span>
                {/* Commit hash + message */}
                <span className="font-mono text-[10px] text-[var(--color-text-tertiary)] flex-shrink-0 mr-1">{c.hash.slice(0, 7)}</span>
                <span className="truncate text-[11px] text-[var(--color-text-primary)]">{c.message}</span>
                {/* Branch refs */}
                {c.refs && (
                  <span className="flex-shrink-0 flex items-center gap-0.5 ml-1">
                    {c.refs.split(',').map((ref, ri) => {
                      const refName = ref.trim();
                      const isHead = refName.startsWith('HEAD ->');
                      const isRemote = refName.startsWith('origin/');
                      const color = isHead ? '#e91e63' : isRemote ? '#4caf50' : '#2196f3';
                      return (
                        <span key={ri} className="text-[9px] px-1 py-0.5 rounded-[var(--radius-sm)] font-medium" style={{ background: `${color}20`, color, whiteSpace: 'nowrap' }}>
                          {refName.replace('HEAD -> ', '')}
                        </span>
                      );
                    })}
                  </span>
                )}
              </div>
              {isOpen && (
                <div className="pl-[66px] pr-2 pb-2">
                  {loadingCommit ? (
                    <div className="text-[var(--color-text-tertiary)] py-1">Loading...</div>
                  ) : commitDetail?.files?.length ? (
                    commitDetail.files.map((f, i) => {
                      const cfg = TYPE_CFG[f.type] || TYPE_CFG.M;
                      return (
                        <div
                          key={i}
                          className="py-0.5 hover:bg-[var(--color-bg-tertiary)] cursor-pointer flex items-center gap-1.5 rounded"
                          onClick={(e) => { e.stopPropagation(); if (commitDetail) emitDiff(f.file, commitDetail.diff); }}
                        >
                          <span style={{ color: cfg.color, fontWeight: 600, fontSize: '9px', width: '14px', textAlign: 'center', flexShrink: 0 }}>{cfg.label}</span>
                          <span className="truncate text-[11px]">{f.file}</span>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-[var(--color-text-tertiary)] py-1 text-[10px]">No changed files</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Collapsible section header (VS Code style) ──────

function SectionHeader({ title, count, open, onToggle, actions }: {
  title: string; count: number; open: boolean; onToggle: () => void;
  actions?: Array<{ label: string; onClick: () => void }>;
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1.5 hover:bg-[var(--color-bg-tertiary)] cursor-pointer select-none border-b border-[var(--color-separator)]" onClick={onToggle}>
      <div className="flex items-center gap-1 min-w-0">
        {open ? <ChevronDown size={12} className="text-[var(--color-text-tertiary)] flex-shrink-0" /> : <ChevronRight size={12} className="text-[var(--color-text-tertiary)] flex-shrink-0" />}
        <span className="font-semibold text-[11px] text-[var(--color-text-primary)]">{title}</span>
        <span className="text-[var(--color-text-tertiary)] text-[10px] ml-0.5">({count})</span>
      </div>
      {actions?.map((a, i) => (
        <button key={i} onClick={(e) => { e.stopPropagation(); a.onClick(); }} className="text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-link)] px-1">
          {a.label}
        </button>
      ))}
    </div>
  );
}

// ── File row (VS Code style tree entry) ────────────

function FileRow({ file, onClick, actionLabel, actionTitle, onAction }: {
  file: GitFile; onClick: () => void; actionLabel: string; actionTitle: string; onAction: () => void;
}) {
  const cfg = TYPE_CFG[file.type] || TYPE_CFG.M;
  const name = file.file.split('/').pop() ?? file.file;
  const dir = file.file.includes('/') ? file.file.slice(0, file.file.lastIndexOf('/')) : '';

  return (
    <div className="group flex items-center gap-1 pl-5 pr-3 py-[3px] hover:bg-[var(--color-bg-tertiary)] cursor-pointer" onClick={onClick}>
      {/* Stage/unstage button */}
      <button
        onClick={(e) => { e.stopPropagation(); onAction(); }}
        className="w-[18px] h-[18px] flex items-center justify-center rounded hover:bg-[var(--color-bg-primary)] text-[11px] font-bold flex-shrink-0"
        style={{ color: actionLabel === '＋' ? '#4caf50' : '#e2b714', opacity: 0.7 }}
        title={actionTitle}
      >
        {actionLabel}
      </button>
      {/* File type indicator */}
      <span style={{ color: cfg.color, fontWeight: 700, fontSize: '10px', width: '14px', textAlign: 'center', flexShrink: 0 }}>{cfg.label}</span>
      {/* File name + path */}
      <div className="min-w-0 flex-1 leading-tight">
        <span className="truncate block text-[var(--color-text-primary)]" style={{ fontSize: '12px' }}>{name}</span>
        {dir && <span className="text-[10px] text-[var(--color-text-tertiary)] block truncate">{dir}</span>}
      </div>
    </div>
  );
}

// ── Git graph ASCII → colored rendering ──────────

function renderGraph(graph: string): React.ReactNode {
  if (!graph) return null;

  // Assign lane colors
  const laneColor: Record<number, string> = {};
  let nc = 0;
  const positions = new Set<number>();
  for (let i = 0; i < graph.length; i++) {
    if (graph[i] === '|' || graph[i] === '/' || graph[i] === '\\') positions.add(i);
  }
  const sorted = [...positions].sort((a, b) => a - b);
  for (const p of sorted) {
    if (!(p in laneColor)) laneColor[p] = BRANCH_COLORS[nc++ % BRANCH_COLORS.length];
  }
  const dotColor = sorted.length > 0 ? laneColor[sorted[0]] : BRANCH_COLORS[0];

  // Build HTML string with colored spans
  let html = '';
  for (let i = 0; i < graph.length; i++) {
    const ch = graph[i];
    if (ch === '*') {
      html += `<span style="color:${dotColor};font-weight:900">●</span>`;
    } else if (ch === '|') {
      html += `<span style="color:${laneColor[i] || '#888'};font-weight:bold">│</span>`;
    } else if (ch === '/') {
      const right = sorted.find(p => p > i);
      html += `<span style="color:${right !== undefined ? laneColor[right] : '#ff9800'}">╱</span>`;
    } else if (ch === '\\') {
      const left = [...sorted].reverse().find(p => p < i);
      html += `<span style="color:${left !== undefined ? laneColor[left] : '#ff9800'}">╲</span>`;
    } else if (ch === '_') {
      html += `<span style="color:${laneColor[sorted[0]] || '#888'}">─</span>`;
    } else {
      html += ' ';
    }
  }

  return <pre style={{ display: 'inline', fontFamily: 'Menlo, Monaco, "Courier New", monospace', fontSize: '11px', lineHeight: '16px', margin: 0, padding: 0, whiteSpace: 'pre' }} dangerouslySetInnerHTML={{ __html: html }} />;
}

GitPanel.displayName = 'GitPanel';
