import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Trash2, List, Folder, ChevronRight } from 'lucide-react';
import { useSessionStore } from '../../store/sessionStore.js';
import { useT, formatRelativeTime } from '../../i18n/index.js';
import type { SessionSummary } from '../../store/types.js';

export interface SessionListProps {
  activeSessionId?: string;
  onSessionSelect?: (sessionId: string) => void;
  searchQuery?: string;
}

type ViewMode = 'flat' | 'workspace';

/** Last path segment (folder name) — handles POSIX and Windows separators. */
function folderName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export function SessionList({
  activeSessionId,
  onSessionSelect,
  searchQuery = '',
}: SessionListProps): React.ReactElement {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const isLoading = useSessionStore((s) => s.isLoading);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('flat');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeleting(id);
    try {
      // deleteSession already removes the entry optimistically.
      await deleteSession(id);
    } catch { /* ignore */ }
    setDeleting(null);
  };

  const filtered = useMemo(
    () => sessions.filter((s) => s.title.toLowerCase().includes(searchQuery.toLowerCase())),
    [sessions, searchQuery],
  );

  // Group sessions by workspace (按工作区). Groups keep recency order — the
  // first-seen (most recent) session of each group determines its position.
  const groups = useMemo(() => {
    if (viewMode !== 'workspace') return null;
    const map = new Map<string, SessionSummary[]>();
    const order: string[] = [];
    for (const s of filtered) {
      const key = s.workDir?.trim() || '';
      if (!map.has(key)) {
        map.set(key, []);
        order.push(key);
      }
      map.get(key)!.push(s);
    }
    return order.map((key) => ({ key, sessions: map.get(key)! }));
  }, [filtered, viewMode]);

  if (isLoading) {
    return <div className="p-4 text-center text-xs text-[var(--color-text-tertiary)]">{t('session.loading')}</div>;
  }

  const renderSession = (session: SessionSummary): React.ReactElement => {
    const isActive = session.id === activeSessionId;
    return (
      <motion.button
        key={session.id}
        onClick={() => onSessionSelect?.(session.id)}
        whileHover={{ backgroundColor: 'var(--color-bg-tertiary)' }}
        whileTap={{ scale: 0.98 }}
        className={`
          w-full text-left px-3 py-2 cursor-pointer transition-colors duration-50 group
          ${isActive ? 'bg-[var(--color-brand)]/10' : ''}
          border-l-[3px]
          ${isActive ? 'border-l-[var(--color-brand)]' : 'border-l-transparent'}
        `}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div
              className={`text-sm font-medium truncate ${
                isActive ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'
              }`}
            >
              {session.title}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--color-text-tertiary)]">
              <span>{formatRelativeTime(session.updatedAt)}</span>
              <span>·</span>
              <span>{t('session.turns', { n: session.turnCount })}</span>
            </div>
          </div>
          <button
            onClick={(e) => handleDelete(e, session.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-[var(--color-bg-primary)]"
            title={t('session.delete')}
          >
            <Trash2 size={12} className="text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)]" />
          </button>
        </div>
      </motion.button>
    );
  };

  const segBtn = (active: boolean): string =>
    `flex-1 flex items-center justify-center gap-1 h-6 rounded-[var(--radius-sm)] text-[11px] transition-colors ${
      active
        ? 'bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] shadow-sm'
        : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
    }`;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* View options — 单列表 / 按工作区 */}
      <div className="px-3 py-1.5 border-b border-[var(--color-separator)] flex-shrink-0">
        <div
          className="flex items-center gap-0.5 rounded-[var(--radius-md)] bg-[var(--color-bg-tertiary)] p-0.5"
          role="group"
          aria-label={t('session.viewOptions')}
        >
          <button type="button" onClick={() => setViewMode('flat')} className={segBtn(viewMode === 'flat')}>
            <List size={12} />
            <span>{t('session.groupByFlat')}</span>
          </button>
          <button type="button" onClick={() => setViewMode('workspace')} className={segBtn(viewMode === 'workspace')}>
            <Folder size={12} />
            <span>{t('session.groupByWorkspace')}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-[var(--color-text-tertiary)]">
            {searchQuery ? t('session.notFound') : t('session.empty')}
          </div>
        ) : viewMode === 'workspace' && groups ? (
          groups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.key);
            return (
              <div key={group.key}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  className="w-full flex items-center gap-1.5 px-3 pt-2 pb-1 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
                >
                  <ChevronRight
                    size={11}
                    className={`flex-shrink-0 text-[var(--color-text-tertiary)] transition-transform ${
                      isCollapsed ? '' : 'rotate-90'
                    }`}
                  />
                  <span className="flex-1 min-w-0 truncate text-[10px] font-bold text-[var(--color-text-secondary)]">
                    {group.key ? folderName(group.key) : t('session.ungrouped')}
                  </span>
                  <span className="flex-shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
                    {group.sessions.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="pl-3.5">
                    {group.sessions.map(renderSession)}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          filtered.map(renderSession)
        )}
      </div>
    </div>
  );
}

SessionList.displayName = 'SessionList';
