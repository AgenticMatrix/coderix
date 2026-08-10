import React, { useEffect, useState, useCallback, useRef } from 'react';
import { GitBranch, RefreshCw, Check, ChevronRight, ChevronDown } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { GitMoreMenu } from './GitMoreMenu';
import { BranchPicker } from './BranchPicker';
import { StashPicker } from './StashPicker';
import { Sparkles } from 'lucide-react';

interface GitFile { file: string; type: string; code: string; }
interface GitCommit { hash: string; message: string; author?: string; date?: string; dateAbsolute?: string; graph?: string; refs?: string; }
interface ShowData { diff: string; files: Array<{ file: string; type: string }>; author?: string; date?: string; filesChanged?: number; insertions?: number; deletions?: number; }

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

export function GitPanel(): React.ReactElement {
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<GitFile[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  // Prevent concurrent load() calls (debounce guard)
  const loadingRef = useRef(false);
  const [commitMsg, setCommitMsg] = useState('');
  const addNotification = useUIStore((s) => s.addNotification);
  const setGitBranch = useUIStore((s) => s.setGitBranch);
  const setGitFileStatuses = useUIStore((s) => s.setGitFileStatuses);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<ShowData | null>(null);
  const [loadingCommit, setLoadingCommit] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(true);
  // Track latest commit detail request to prevent stale updates (race condition fix)
  const latestCommitRequestRef = useRef<string | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [stashPickerOpen, setStashPickerOpen] = useState(false);
  const [amend, setAmend] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [hoveredCommit, setHoveredCommit] = useState<{ commit: GitCommit; body?: string; x: number; y: number } | null>(null);
  // Commit message history (localStorage per repo)
  const [msgHistory, setMsgHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('coderix-commit-msgs') || '[]'); } catch { return []; }
  });

  function emitDiff(file: string, diff: string, content?: string) {
  window.dispatchEvent(new CustomEvent('coderix:open-diff', { detail: { file, diff, content } }));
}

const api = window.coderixAPI?.git;

  // Fetch full commit body on hover for tooltip
  useEffect(() => {
    if (!hoveredCommit?.commit.hash || !api) return;
    let cancelled = false;
    (api as any).commitBody?.(hoveredCommit.commit.hash).then((r: any) => {
      if (!cancelled && r?.body) {
        setHoveredCommit(prev => prev?.commit.hash === hoveredCommit.commit.hash ? { ...prev, body: r.body } : prev);
      }
    });
    return () => { cancelled = true; };
  }, [hoveredCommit?.commit.hash, api]);

  // Derived file lists (must be before handlers that reference them)
  const staged = files.filter(f => f.code[0] !== ' ' && f.code[0] !== '?');
  const unstaged = files.filter(f => f.code[1] !== ' ' || f.code[0] === '?');

  const load = useCallback(async (silent = false) => {
    if (!api || loadingRef.current) return;
    loadingRef.current = true;
    if (!silent) setLoading(true);
    try {
      const s = await api.status();
      setBranch(s.branch);
      setFiles(s.files || []);
      setCommits(s.commits || []);
      setGitBranch(s.branch, s.ahead, s.behind);
      // Build file status map for FileExplorer decorations
      const statusMap: Record<string, string> = {};
      for (const f of s.files || []) {
        const st = f.code[0] !== ' ' && f.code[0] !== '?' ? 'modified' :
                   f.code.includes('?') ? 'untracked' :
                   f.code.includes('A') ? 'added' :
                   f.code.includes('D') ? 'deleted' : 'modified';
        statusMap[f.file] = st;
      }
      setGitFileStatuses(statusMap);
    } catch (e) {
      if (!silent) {
        addNotification({
          type: 'error',
          message: 'Failed to get git status',
          detail: (e as Error).message,
        });
      }
    }
    if (!silent) setLoading(false);
    loadingRef.current = false;
  }, [api, addNotification, setGitBranch, setGitFileStatuses]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh: silently poll git status every 5s
  useEffect(() => {
    const interval = setInterval(() => { load(true); }, 5000);
    return () => clearInterval(interval);
  }, [load]);

  const handleCommit = useCallback(async () => {
    if (!api || !commitMsg.trim()) return;
    const r = amend
      ? await api.commitAmend(commitMsg.trim())
      : await api.commit(commitMsg.trim());
    if (r.status === 'error') {
      addNotification({
        type: 'error',
        message: amend ? 'Failed to amend' : 'Failed to commit',
        detail: r.error || 'Unknown error',
      });
      return;
    }
    // Save to history (dedup, max 20)
    const history = [commitMsg.trim(), ...msgHistory.filter(m => m !== commitMsg.trim())].slice(0, 20);
    setMsgHistory(history);
    try { localStorage.setItem('coderix-commit-msgs', JSON.stringify(history)); } catch { /* ignore */ }
    addNotification({ type: 'success', message: amend ? 'Amended successfully' : 'Committed successfully' });
    setCommitMsg('');
    setAmend(false);
    load();
  }, [api, commitMsg, load, addNotification, amend, msgHistory]);

  // AI commit message generation
  const handleAiGenerate = useCallback(async () => {
    if (!api || aiGenerating) return;
    setAiGenerating(true);
    try {
      // Get diff of staged changes (or all changes if nothing staged)
      const filesToDiff = staged.length > 0 ? staged : unstaged;
      if (filesToDiff.length === 0) {
        addNotification({ type: 'warning', message: 'No changes to generate commit message for' });
        setAiGenerating(false);
        return;
      }
      // Build diff from all changed files (first 3 for prompt size)
      let diffText = '';
      const stagedFlag = staged.length > 0;
      for (let i = 0; i < Math.min(filesToDiff.length, 5); i++) {
        const r = await api.diff(filesToDiff[i].file, stagedFlag);
        if (r.diff) diffText += r.diff.slice(0, 2000) + '\n';
      }
      if (!diffText.trim()) {
        addNotification({ type: 'warning', message: 'No diff content available' });
        setAiGenerating(false);
        return;
      }

      const prompt = `Generate a concise commit message following conventional commits format (type: description) for these changes. One line only, no explanation. Here is the diff:\n\n${diffText.slice(0, 4000)}`;

      // Submit query and listen for stream events
      const fullApi = (window as any).coderixAPI;
      if (!fullApi?.query?.submit) {
        addNotification({ type: 'error', message: 'AI query not available' });
        setAiGenerating(false);
        return;
      }

      let collected = '';
      const unsub = fullApi.onStreamEvent((evt: any) => {
        if (evt.type === 'blockDelta' && evt.delta) {
          collected += evt.delta;
        } else if (evt.type === 'done') {
          unsub();
          const msg = collected.replace(/^```[a-z]*\n?/i, '').replace(/\n```$/i, '').trim();
          if (msg) {
            setCommitMsg(msg);
            addNotification({ type: 'success', message: 'Commit message generated' });
          } else {
            addNotification({ type: 'warning', message: 'AI did not return a message' });
          }
          setAiGenerating(false);
        } else if (evt.type === 'error') {
          unsub();
          addNotification({ type: 'error', message: 'AI generation failed', detail: evt.message });
          setAiGenerating(false);
        }
      });

      await fullApi.query.submit(prompt);
    } catch (e) {
      addNotification({ type: 'error', message: 'AI generation failed', detail: (e as Error).message });
      setAiGenerating(false);
    }
  }, [api, aiGenerating, staged, unstaged, addNotification]);

  const handleStage = useCallback(async (file: string) => {
    const r = await api?.stage(file);
    if (r?.status === 'error') addNotification({ type: 'error', message: `Failed to stage ${file}`, detail: (r as any).error });
    load();
  }, [api, load, addNotification]);
  const handleUnstage = useCallback(async (file: string) => {
    const r = await api?.unstage(file);
    if (r?.status === 'error') addNotification({ type: 'error', message: `Failed to unstage ${file}`, detail: (r as any).error });
    load();
  }, [api, load, addNotification]);
  const handleStageAll = useCallback(async () => {
    const r = await api?.stage(undefined, true);
    if (r?.status === 'error') addNotification({ type: 'error', message: 'Failed to stage all files', detail: (r as any).error });
    load();
  }, [api, load, addNotification]);
  const handleUnstageAll = useCallback(async () => {
    const r = await api?.unstage(undefined, true);
    if (r?.status === 'error') addNotification({ type: 'error', message: 'Failed to unstage all files', detail: (r as any).error });
    load();
  }, [api, load, addNotification]);

  // ── Remote operations ────────────────────────────────
  const handlePush = useCallback(async () => {
    const r = await api?.push();
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: r.output || 'Pushed successfully' });
    } else {
      addNotification({ type: 'error', message: 'Push failed', detail: r?.error || 'Unknown error' });
    }
  }, [api, addNotification]);

  const handlePull = useCallback(async () => {
    const r = await api?.pull();
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: r.output || 'Pulled successfully' });
      load();
    } else {
      addNotification({ type: 'error', message: 'Pull failed', detail: r?.error || 'Unknown error' });
    }
  }, [api, addNotification, load]);

  const handleFetch = useCallback(async () => {
    const r = await api?.fetch();
    if (r?.status === 'ok') {
      addNotification({ type: 'info', message: r.output || 'Fetch completed' });
      load();
    } else {
      addNotification({ type: 'error', message: 'Fetch failed', detail: r?.error || 'Unknown error' });
    }
  }, [api, addNotification, load]);

  const handleDiscardAll = useCallback(async () => {
    // Discard all unstaged changes
    for (const f of unstaged) {
      const r = await api?.discard(f.file);
      if (r?.status === 'error') {
        addNotification({ type: 'error', message: `Failed to discard ${f.file}`, detail: (r as any).error });
        return;
      }
    }
    addNotification({ type: 'success', message: 'All changes discarded' });
    load();
  }, [api, addNotification, load, unstaged]);

  const handleViewDiff = useCallback(async (file: string, staged?: boolean) => {
    if (!api) return;
    const r = await api.diff(file, staged);
    if (r.diff) emitDiff(file, r.diff);
  }, [api]);

  const handleDiscardFile = useCallback(async (file: string) => {
    const r = await api?.discard(file);
    if (r?.status === 'ok') {
      addNotification({ type: 'success', message: `Discarded ${file.split('/').pop()}` });
      load();
    } else {
      addNotification({ type: 'error', message: `Failed to discard ${file}`, detail: (r as any)?.error });
    }
  }, [api, addNotification, load]);

  const handleCopyPath = useCallback(async (file: string) => {
    try { await navigator.clipboard.writeText(file); } catch { /* ignore */ }
  }, []);

  const handleExpandCommit = useCallback(async (hash: string) => {
    if (expandedCommit === hash) { setExpandedCommit(null); return; }
    setExpandedCommit(hash);
    setLoadingCommit(true);
    setCommitDetail(null); // clear stale detail immediately
    latestCommitRequestRef.current = hash;
    try {
      const r = await api?.show(hash);
      // Discard result if a newer request was made (race condition fix)
      if (latestCommitRequestRef.current !== hash) return;
      setCommitDetail(r || null);
    } catch {
      if (latestCommitRequestRef.current !== hash) return;
      setCommitDetail(null);
    }
    if (latestCommitRequestRef.current === hash) {
      setLoadingCommit(false);
    }
  }, [api, expandedCommit]);
  if (loading) {
    return <div className="flex flex-col h-full text-xs"><div className="p-4 text-center text-[var(--color-text-tertiary)]">Loading...</div></div>;
  }

  return (
    <>
    <div className="flex flex-col h-full text-xs">
      {/* ── Header bar ────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 h-[35px] border-b border-[var(--color-separator)] flex-shrink-0">
        <span className="font-semibold text-[11px] text-[var(--color-text-secondary)] uppercase tracking-wide">Source Control</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => load()} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-tertiary)]" title="Refresh"><RefreshCw size={12} /></button>
          <GitMoreMenu
            onPush={handlePush}
            onPull={handlePull}
            onFetch={handleFetch}
            onDiscardAll={handleDiscardAll}
            onBranches={() => setBranchPickerOpen(true)}
            onStash={() => setStashPickerOpen(true)}
            hasChanges={unstaged.length > 0}
          />
        </div>
      </div>

      {/* ── Commit message input ───────────────────────── */}
      <div className="px-3 py-2 border-b border-[var(--color-separator)] flex-shrink-0">
        <div className="flex gap-1.5">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Message (⌘Enter to commit)"
            className="flex-1 min-h-[28px] max-h-[120px] px-2 py-1 rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-input-bg)] text-[var(--color-text-primary)] text-xs outline-none resize-none"
            rows={1}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleCommit();
              }
            }}
            onInput={(e) => {
              const target = e.currentTarget;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 120) + 'px';
            }}
          />
          <button
            onClick={handleAiGenerate}
            disabled={aiGenerating || (staged.length === 0 && unstaged.length === 0)}
            className="h-7 w-7 rounded-[var(--radius-md)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:text-[var(--color-brand)] hover:bg-[var(--color-brand)]/10 disabled:opacity-30 flex items-center justify-center flex-shrink-0 transition-colors"
            title="AI Generate (✨)"
          >
            <Sparkles size={14} />
          </button>
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim() || (staged.length === 0 && unstaged.length === 0)}
            className="h-7 w-7 rounded-[var(--radius-md)] bg-[var(--color-brand)] text-white disabled:opacity-30 flex items-center justify-center flex-shrink-0"
            title="Commit (⌘Enter)"
          >
            <Check size={14} strokeWidth={2.5} />
          </button>
        </div>
        {/* Amend checkbox & history */}
        <div className="flex items-center gap-3 mt-1">
          <label className="flex items-center gap-1 text-[10px] text-[var(--color-text-tertiary)] cursor-pointer select-none">
            <input type="checkbox" checked={amend} onChange={e => setAmend(e.target.checked)} />
            Amend
          </label>
          {msgHistory.length > 0 && (
            <div className="relative">
              <button onClick={() => setShowHistory(!showHistory)} className="text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-link)]">
                History ({msgHistory.length})
              </button>
              {showHistory && (
                <div className="absolute bottom-full left-0 mb-1 w-64 max-h-32 overflow-y-auto rounded-[var(--radius-md)] bg-[var(--color-bg-primary)] border border-[var(--color-separator)] shadow-lg z-50">
                  {msgHistory.map((m, i) => (
                    <div key={i} onClick={() => { setCommitMsg(m); setShowHistory(false); }}
                      className="px-2 py-1 text-[11px] hover:bg-[var(--color-bg-tertiary)] cursor-pointer truncate text-[var(--color-text-primary)] border-b border-[var(--color-separator)]/50 last:border-0"
                    >{m}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {/* Branch indicator — always visible */}
        <div className="flex items-center gap-1 mt-1 text-[10px] text-[var(--color-text-secondary)]">
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
          <FileRow key={`s-${i}`} file={f} onClick={() => handleViewDiff(f.file, true)} actionLabel="−" actionTitle="Unstage" onAction={() => handleUnstage(f.file)}
            contextActions={[
              { label: 'Unstage', onClick: () => handleUnstage(f.file) },
              { label: 'Discard', danger: true, onClick: () => handleDiscardFile(f.file) },
              { label: 'Copy Relative Path', onClick: () => handleCopyPath(f.file) },
            ]}
          />
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
            <FileRow key={`u-${i}`} file={f} onClick={() => handleViewDiff(f.file)} actionLabel="＋" actionTitle="Stage" onAction={() => handleStage(f.file)}
              contextActions={[
                { label: 'Stage', onClick: () => handleStage(f.file) },
                { label: 'Discard', danger: true, onClick: () => handleDiscardFile(f.file) },
                { label: 'Copy Relative Path', onClick: () => handleCopyPath(f.file) },
              ]}
            />
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
                onMouseEnter={(e) => { if (c.author) setHoveredCommit({ commit: c, x: e.clientX, y: e.clientY }); }}
                onMouseMove={(e) => { if (hoveredCommit?.commit.hash === c.hash) setHoveredCommit(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev); }}
                onMouseLeave={() => setHoveredCommit(null)}
                style={{ paddingLeft: '2px', lineHeight: '16px', minHeight: '16px' }}
              >
                {/* Graph visualization */}
                <span className="font-mono text-[11px] leading-none flex-shrink-0" style={{ width: '60px', whiteSpace: 'pre' }}>
                  {c.graph ? renderGraph(c.graph) : ''}
                </span>
                {/* Commit hash + message */}
                <span className="font-mono text-[10px] text-[var(--color-text-tertiary)] flex-shrink-0 mr-1">{c.hash.slice(0, 7)}</span>
                <span className="truncate text-[11px] text-[var(--color-text-primary)]">{c.message}</span>
                {c.author && (
                  <span className="text-[9px] text-[var(--color-text-tertiary)] flex-shrink-0 hidden group-hover:inline ml-1">
                    {c.author} · {c.date}
                  </span>
                )}
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
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!commitDetail || !api) return;
                            const fileHash = expandedCommit;
                            if (fileHash) {
                              (api as any).showFile?.(fileHash, f.file).then((r: any) => {
                                emitDiff(f.file, r?.diff || commitDetail.diff, r?.content || '');
                              });
                            } else {
                              emitDiff(f.file, commitDetail.diff);
                            }
                          }}
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
    {/* Branch picker modal */}
    {branchPickerOpen && <BranchPicker onClose={() => { setBranchPickerOpen(false); load(); }} />}
    {/* Stash picker modal */}
    {stashPickerOpen && <StashPicker onClose={() => { setStashPickerOpen(false); load(); }} />}
    {/* Commit hover tooltip */}
    {hoveredCommit?.commit.author && (
      <div className="fixed z-[9999] pointer-events-none rounded-[var(--radius-md)] bg-[var(--color-bg-primary)] border border-[var(--color-separator)] shadow-xl p-3 max-w-sm"
        style={{ left: Math.min(hoveredCommit.x, window.innerWidth - 360), top: hoveredCommit.y + 10 }}>
        <div className="text-xs font-medium text-[var(--color-text-primary)] mb-1">{hoveredCommit.commit.author}</div>
        <div className="text-[11px] text-[var(--color-text-secondary)] mb-2">
          {hoveredCommit.commit.date}
          {hoveredCommit.commit.dateAbsolute && ` (${hoveredCommit.commit.dateAbsolute})`}
        </div>
        <div className="text-[11px] text-[var(--color-text-primary)] whitespace-pre-wrap leading-relaxed mb-2">
          {hoveredCommit.body || hoveredCommit.commit.message}
        </div>
        <div className="text-[10px] text-[var(--color-text-tertiary)] font-mono">{hoveredCommit.commit.hash}</div>
      </div>
    )}
    </>
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

function FileRow({ file, onClick, actionLabel, actionTitle, onAction, contextActions }: {
  file: GitFile; onClick: () => void; actionLabel: string; actionTitle: string; onAction: () => void;
  contextActions?: Array<{ label: string; danger?: boolean; onClick: () => void }>;
}) {
  const cfg = TYPE_CFG[file.type] || TYPE_CFG.M;
  const name = file.file.split('/').pop() ?? file.file;
  const dir = file.file.includes('/') ? file.file.slice(0, file.file.lastIndexOf('/')) : '';
  const [menuOpen, setMenuOpen] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <div className="group flex items-center gap-1 pl-5 pr-3 py-[3px] hover:bg-[var(--color-bg-tertiary)] cursor-pointer"
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          if (contextActions?.length) setMenuOpen({ x: e.clientX, y: e.clientY });
        }}
      >
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
      {/* Context menu */}
      {menuOpen && contextActions && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setMenuOpen(null)} onContextMenu={e => { e.preventDefault(); setMenuOpen(null); }} />
          <div className="fixed z-50 rounded-[var(--radius-md)] bg-[var(--color-bg-primary)] border border-[var(--color-separator)] shadow-lg py-1 w-44" style={{ left: menuOpen.x, top: menuOpen.y }}>
            {contextActions.map((a, i) => (
              <button key={i} onClick={() => { a.onClick(); setMenuOpen(null); }}
                className="w-full text-left px-3 py-1 text-xs hover:bg-[var(--color-bg-tertiary)]"
                style={{ color: a.danger ? '#f44336' : 'var(--color-text-primary)' }}
              >{a.label}</button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ── Git graph ASCII → colored React element rendering ──────────

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

  // Build React elements (no dangerouslySetInnerHTML)
  const chars = [...graph].map((ch, i) => {
    if (ch === '*') {
      return <span key={i} style={{ color: dotColor, fontWeight: 900 }}>●</span>;
    } else if (ch === '|') {
      return <span key={i} style={{ color: laneColor[i] || '#888', fontWeight: 'bold' }}>│</span>;
    } else if (ch === '/') {
      const right = sorted.find(p => p > i);
      return <span key={i} style={{ color: right !== undefined ? laneColor[right] : '#ff9800' }}>╱</span>;
    } else if (ch === '\\') {
      const left = [...sorted].reverse().find(p => p < i);
      return <span key={i} style={{ color: left !== undefined ? laneColor[left] : '#ff9800' }}>╲</span>;
    } else if (ch === '_') {
      return <span key={i} style={{ color: laneColor[sorted[0]] || '#888' }}>─</span>;
    } else {
      return <React.Fragment key={i}> </React.Fragment>;
    }
  });

  return (
    <span style={{
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: '11px',
      lineHeight: '16px',
      whiteSpace: 'pre',
    }}>
      {chars}
    </span>
  );
}

GitPanel.displayName = 'GitPanel';
