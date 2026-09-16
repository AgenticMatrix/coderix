import React, { useEffect, useState } from 'react';
import { Search, File, Folder, FileText, GitBranch } from 'lucide-react';
import { FileExplorer } from './FileExplorer';
import { GitPanel } from './GitPanel';
import { useT } from '../../i18n/index.js';

type ProjectTab = 'files' | 'git';

interface FileSearchMatch {
  path: string;
  name: string;
  type: 'file' | 'directory';
  matched: 'name' | 'content';
  line?: string;
}

interface CommitInfo {
  hash: string;
  message: string;
  refs?: string;
}

/**
 * ProjectPanel — the merged "项目管理" view. Combines the file explorer and the
 * source-control (git) manager behind a two-tab segmented control, with a
 * project-wide search box above it. The search is contextual to the active tab:
 * "文件" searches file names + content, "Git" searches commits.
 */
export function ProjectPanel({ projectPath }: { projectPath?: string }): React.ReactElement {
  const [tab, setTab] = useState<ProjectTab>('files');
  const [query, setQuery] = useState('');
  const t = useT();
  const searchingActive = query.trim().length > 0;

  return (
    <div className="h-full flex flex-col">
      {/* Search — contextual to the active tab */}
      <div className="px-3 pt-2 pb-2 flex-shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-0 bottom-0 my-auto pointer-events-none text-[var(--color-text-tertiary)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === 'git' ? t('project.searchCommits') : t('project.searchFiles')}
            className="
              w-full h-7 pl-7 pr-2 text-xs rounded-[var(--radius-md)]
              bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]
              placeholder:text-[var(--color-text-tertiary)]
              border border-transparent
              focus:border-[var(--color-brand)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]/20
              transition-colors
            "
          />
        </div>
      </div>

      {/* Tab bar — sits above the file/git list, Apple-style segmented control */}
      <div className="px-3 pb-2 flex-shrink-0">
        <div className="flex bg-[var(--color-bg-tertiary)] rounded-[var(--radius-md)] p-0.5">
          <TabButton
            active={tab === 'files'}
            onClick={() => setTab('files')}
            label={t('project.tabFiles')}
          />
          <TabButton
            active={tab === 'git'}
            onClick={() => setTab('git')}
            label={t('project.tabGit')}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {searchingActive ? (
          tab === 'files' ? <FileSearch query={query} /> : <CommitSearch query={query} />
        ) : (
          tab === 'files' ? <FileExplorer projectPath={projectPath} /> : <GitPanel projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}

ProjectPanel.displayName = 'ProjectPanel';

// ── File / content search ─────────────────────────────────────────────────

function FileSearch({ query }: { query: string }): React.ReactElement {
  const [matches, setMatches] = useState<FileSearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const t = useT();

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const api = window.coderixAPI?.fs;
        if (!api) return;
        const res = await api.search(q);
        if (!cancelled) setMatches(res?.matches ?? []);
      } catch {
        if (!cancelled) setMatches([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  if (searching) {
    return <div className="p-4 text-xs text-center text-[var(--color-text-tertiary)]">{t('project.searching')}</div>;
  }
  if (matches.length === 0) {
    return <div className="p-4 text-xs text-center text-[var(--color-text-tertiary)]">{t('project.noResults')}</div>;
  }

  const openFile = async (match: FileSearchMatch) => {
    if (match.type !== 'file') return;
    const api = window.coderixAPI?.fs;
    if (!api) return;
    try {
      const res = await api.readFile(match.path);
      if (res?.content) {
        window.dispatchEvent(
          new CustomEvent('coderix:open-file', {
            detail: { path: match.path, name: match.name, content: res.content },
          }),
        );
      }
    } catch {
      /* file read error */
    }
  };

  return (
    <div className="py-1">
      {matches.map((m) => (
        <button
          key={`${m.type}-${m.path}`}
          type="button"
          onClick={() => openFile(m)}
          disabled={m.type !== 'file'}
          className={`w-full flex items-start gap-2 px-3 py-1 text-xs text-left transition-colors
            ${m.type === 'file' ? 'hover:bg-[var(--color-bg-tertiary)] cursor-pointer' : 'cursor-default'}`}
        >
          <span className="flex-shrink-0 mt-px text-[var(--color-text-tertiary)]">
            {m.type === 'directory' ? <Folder size={13} /> : m.matched === 'content' ? <FileText size={13} /> : <File size={13} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[var(--color-text-primary)]">
              {m.name}
              {m.matched === 'content' && <span className="text-[var(--color-text-tertiary)]"> · {t('project.inContent')}</span>}
            </span>
            {m.line ? (
              <span className="block truncate text-[var(--color-text-tertiary)] font-mono">{m.line}</span>
            ) : (
              <span className="block truncate text-[var(--color-text-tertiary)]">{m.path}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Commit search ─────────────────────────────────────────────────────────

function CommitSearch({ query }: { query: string }): React.ReactElement {
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [searching, setSearching] = useState(false);
  const t = useT();

  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setCommits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const api = window.coderixAPI?.git;
        if (!api) return;
        const res = await api.log(300);
        const filtered = (res?.commits ?? []).filter(
          (c) =>
            (c.message || '').toLowerCase().includes(q) ||
            (c.hash || '').toLowerCase().startsWith(q) ||
            (c.refs || '').toLowerCase().includes(q),
        );
        if (!cancelled) setCommits(filtered);
      } catch {
        if (!cancelled) setCommits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  if (searching) {
    return <div className="p-4 text-xs text-center text-[var(--color-text-tertiary)]">{t('project.searching')}</div>;
  }
  if (commits.length === 0) {
    return <div className="p-4 text-xs text-center text-[var(--color-text-tertiary)]">{t('project.noCommits')}</div>;
  }

  return (
    <div className="py-1">
      {commits.map((c) => (
        <div
          key={c.hash}
          className="px-3 py-1.5 flex items-start gap-2 text-xs border-b border-[var(--color-separator)]/50 last:border-0"
        >
          <GitBranch size={11} className="mt-0.5 flex-shrink-0 text-[var(--color-text-tertiary)]" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[var(--color-text-tertiary)]">{c.hash.slice(0, 7)}</span>
              {c.refs && <span className="text-[var(--color-brand)] truncate">{c.refs}</span>}
            </div>
            <div className="truncate text-[var(--color-text-primary)]">{c.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 flex items-center justify-center py-1 text-xs font-medium rounded-[var(--radius-sm)] transition-colors
        ${active
          ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm'
          : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'}`}
    >
      {label}
    </button>
  );
}
