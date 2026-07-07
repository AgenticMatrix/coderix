import React, { useEffect, useState } from 'react';
import { GitBranch, FileText, Plus, Minus, RefreshCw } from 'lucide-react';

interface GitFile {
  file: string;
  type: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
  code: string;
}

const typeConfig: Record<string, { label: string; color: string; icon: React.ReactElement }> = {
  modified: { label: 'M', color: '#e2b714', icon: <Minus size={12} /> },
  added: { label: 'A', color: '#4caf50', icon: <Plus size={12} /> },
  deleted: { label: 'D', color: '#f44336', icon: <Minus size={12} /> },
  untracked: { label: 'U', color: '#4caf50', icon: <Plus size={12} /> },
  renamed: { label: 'R', color: '#2196f3', icon: <RefreshCw size={12} /> },
};

export function GitPanel(): React.ReactElement {
  const [branch, setBranch] = useState<string>('');
  const [files, setFiles] = useState<GitFile[]>([]);
  const [commits, setCommits] = useState<Array<{ hash: string; message: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadStatus = async () => {
    setLoading(true);
    setError('');
    try {
      if (window.coderixAPI?.git?.status) {
        const data = await window.coderixAPI.git.status();
        setBranch(data.branch);
        setFiles(data.files);
        setCommits(data.commits || []);
        if (!data.branch && !data.files?.length) setError('未找到 Git 仓库');
      } else {
        setError('Git API 不可用');
      }
    } catch (e) {
      setError('Git 错误: ' + (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  if (loading) {
    return (
      <div className="p-4 text-xs text-[var(--color-text-tertiary)] text-center">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide">
          Source Control
        </span>
        <button onClick={loadStatus} className="p-1 rounded hover:bg-[var(--color-bg-tertiary)]" title="Refresh">
          <RefreshCw size={14} className="text-[var(--color-text-tertiary)]" />
        </button>
      </div>

      {/* Branch */}
      {branch && (
        <div className="px-3 py-1 flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
          <GitBranch size={12} />
          <span className="font-mono">{branch}</span>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="text-xs text-[var(--color-text-tertiary)] text-center py-8">{error}</div>
        )}
        {!error && files.length === 0 && commits.length === 0 && (
          <div className="text-xs text-[var(--color-text-tertiary)] text-center py-8">没有更改</div>
        )}
        {files.map((f, i) => {
            const cfg = typeConfig[f.type] ?? typeConfig.modified;
            const fileName = f.file.split('/').pop() ?? f.file;
            const dir = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : '';

            return (
              <div key={i} className="px-3 py-1 hover:bg-[var(--color-bg-tertiary)] cursor-pointer flex items-center gap-2">
                <span style={{ color: cfg.color, fontWeight: 600, fontSize: '11px', width: '14px', textAlign: 'center' }}>
                  {cfg.label}
                </span>
                <FileText size={12} className="text-[var(--color-text-tertiary)] flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-[var(--color-text-primary)] truncate block">{fileName}</span>
                  {dir && <span className="text-[10px] text-[var(--color-text-tertiary)]">{dir}</span>}
                </div>
              </div>
            );
          })}
        {/* Commit history */}
        {commits.length > 0 && (
          <div className="mt-2 border-t border-[var(--color-separator)]">
            <div className="px-3 py-2 text-[10px] font-semibold text-[var(--color-text-tertiary)] uppercase">
              Commits
            </div>
            {commits.map((c, i) => (
              <div key={i} className="px-3 py-1 hover:bg-[var(--color-bg-tertiary)] flex items-center gap-2">
                <span className="text-[10px] font-mono text-[var(--color-text-tertiary)]">{c.hash.slice(0, 7)}</span>
                <span className="text-xs text-[var(--color-text-primary)] truncate">{c.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

GitPanel.displayName = 'GitPanel';
