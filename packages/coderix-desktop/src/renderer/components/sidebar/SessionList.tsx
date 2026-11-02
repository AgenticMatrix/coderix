import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { List, Folder, ChevronRight, Monitor, Terminal } from 'lucide-react';
import { useSessionStore } from '../../store/sessionStore.js';
import { useChatStore } from '../../store/chatStore.js';
import { useStreamStore } from '../../store/streamStore.js';
import { deriveSessionListStatus, type SessionListStatus } from '../../session-status.js';
import { useT, formatRelativeTime } from '../../i18n/index.js';
import type { SessionSummary } from '../../store/types.js';

export interface SessionListProps {
  activeSessionId?: string;
  onSessionSelect?: (sessionId: string) => void;
  searchQuery?: string;
  /** Live status of the viewed conversation, projected from the bottom status
   *  bar. The row mirrors it so the two can never disagree. */
  viewedStatus?: SessionListStatus;
}

type ViewMode = 'flat' | 'workspace';

/** Last path segment (folder name) — handles POSIX and Windows separators. */
function folderName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Icon marking which client created the conversation shown in the row. */
export function SessionOriginBadge({
  origin,
}: {
  origin?: SessionSummary['origin'];
}): React.ReactElement | null {
  const t = useT();
  if (origin === 'desktop') {
    return (
      <span
        className="flex-shrink-0 inline-flex items-center text-[var(--color-blue)]"
        title={t('session.origin.desktop')}
        aria-label={t('session.origin.desktop')}
        role="img"
      >
        <Monitor size={11} aria-hidden="true" />
      </span>
    );
  }
  if (origin === 'cli') {
    return (
      <span
        className="flex-shrink-0 inline-flex items-center text-[var(--color-purple)]"
        title={t('session.origin.cli')}
        aria-label={t('session.origin.cli')}
        role="img"
      >
        <Terminal size={11} aria-hidden="true" />
      </span>
    );
  }
  return null;
}

/** Live busy / wait / idle dot shown at the bottom-right of a conversation row. */
export function SessionStatusBadge({
  status,
}: {
  status: SessionListStatus;
}): React.ReactElement {
  const t = useT();
  const meta =
    status === 'busy'
      ? {
          labelKey: 'session.status.busy' as const,
          hintKey: 'session.status.busyHint' as const,
          dot: 'bg-[var(--color-danger)]',
          text: 'text-[var(--color-danger)]',
        }
      : status === 'wait'
        ? {
            labelKey: 'session.status.wait' as const,
            hintKey: 'session.status.waitHint' as const,
            dot: 'bg-[var(--color-warning)]',
            text: 'text-[var(--color-warning)]',
          }
        : {
            labelKey: 'session.status.idle' as const,
            hintKey: 'session.status.idleHint' as const,
            // Same green as the bottom bar's idle badge.
            dot: 'bg-[var(--color-success)]',
            text: 'text-[var(--color-success)]',
          };
  const hint = t(meta.hintKey);

  return (
    <span
      className={`flex-shrink-0 inline-flex items-center gap-1 text-[10px] leading-none ${meta.text}`}
      title={hint}
      aria-label={hint}
      role="status"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${
          status === 'idle' ? '' : 'animate-pulse'
        }`}
        aria-hidden="true"
      />
      <span>{t(meta.labelKey)}</span>
    </span>
  );
}

export function SessionList({
  activeSessionId,
  onSessionSelect,
  searchQuery = '',
  viewedStatus,
}: SessionListProps): React.ReactElement {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const isLoading = useSessionStore((s) => s.isLoading);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  // Live status sources. The viewed session keeps its streaming flag in the
  // flat slot; backgrounded sessions keep theirs (and all stream phases) in the
  // per-session maps.
  const viewedSessionId = useChatStore((s) => s.sessionId);
  const viewedStreaming = useChatStore((s) => s.isStreaming);
  const streamingBySession = useChatStore((s) => s.streamingBySession);
  const requestingBySession = useStreamStore((s) => s.requestingBySession);
  const runningTasksBySession = useStreamStore((s) => s.runningTasksBySession);
  const compactingBySession = useStreamStore((s) => s.compactingBySession);
  const awaitingUserBySession = useStreamStore((s) => s.awaitingUserBySession);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('flat');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      // deleteSession already removes the entry optimistically.
      await deleteSession(id);
    } catch { /* ignore */ }
    setDeleting(null);
  };

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    // Sessions are titled after their FIRST user message, which may be a setup
    // question ("你的工作目录是哪个") rather than the real topic. Search the
    // preview fields too so a conversation stays findable by what was actually
    // asked later on.
    return sessions.filter((s) =>
      [s.title, s.displayTitle, s.lastUserPreview, s.firstUserText].some(
        (value) => value?.toLowerCase().includes(query),
      ),
    );
  }, [sessions, searchQuery]);

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

  const renderSession = (session: SessionSummary, indented = false): React.ReactElement => {
    const isActive = session.id === activeSessionId;
    const isViewed = session.id === (viewedSessionId ?? activeSessionId);
    // The viewed conversation mirrors the bottom bar's phase. Everything else
    // (backgrounded sessions) only has the per-session maps to go on.
    const liveStatus = deriveSessionListStatus({
      streaming: isViewed ? viewedStreaming : Boolean(streamingBySession[session.id]),
      awaitingUser: Boolean(awaitingUserBySession[session.id]),
      compacting: Boolean(compactingBySession[session.id]),
      requesting: Boolean(requestingBySession[session.id]),
      runningTaskCount: runningTasksBySession[session.id]?.length ?? 0,
      leaseBusy: session.busy,
    });
    // `viewedStatus` is derived from the same flat state the bottom bar uses, so
    // prefer it for the session actually loaded in the chat store. A lease held
    // by another client is the one signal the local bar cannot see — it must
    // still read busy.
    const status =
      session.id === viewedSessionId && viewedStatus && !session.busy
        ? viewedStatus
        : liveStatus;
    return (
      <motion.button
        key={session.id}
        onClick={() => onSessionSelect?.(session.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ id: session.id, x: e.clientX, y: e.clientY });
        }}
        whileTap={{ scale: 0.98 }}
        className={`
          w-full text-left ${indented ? 'pl-[26px]' : 'pl-3'} pr-3 py-2 cursor-pointer transition-colors duration-50 group
          ${
            isActive
              ? 'bg-[var(--color-session-active)]'
              : 'hover:bg-[var(--color-bg-tertiary)]'
          }
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
              <SessionOriginBadge origin={session.origin} />
              <span>{formatRelativeTime(session.updatedAt)}</span>
              <span>·</span>
              <span>{t('session.turns', { n: session.turnCount })}</span>
              <span className="ml-auto inline-flex items-center">
                <SessionStatusBadge status={status} />
              </span>
            </div>
          </div>
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
                  className="w-full flex items-center gap-1.5 px-3 pt-2 pb-1 text-left bg-[var(--color-brand-muted)] transition-colors"
                >
                  <ChevronRight
                    size={11}
                    className={`flex-shrink-0 text-[var(--color-brand)] transition-transform ${
                      isCollapsed ? '' : 'rotate-90'
                    }`}
                  />
                  <span className="flex-1 min-w-0 truncate text-[10px] font-bold text-[var(--color-brand)]">
                    {group.key ? folderName(group.key) : t('session.ungrouped')}
                  </span>
                  <span className="flex-shrink-0 text-[10px] text-[var(--color-brand)]">
                    {group.sessions.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div>
                    {group.sessions.map((s) => renderSession(s, true))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          filtered.map((s) => renderSession(s))
        )}
      </div>
      {/* Session context menu — right-click only, to avoid accidental deletes */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
          />
          <div
            className="fixed z-50 rounded-[var(--radius-md)] bg-[var(--color-bg-primary)] border border-[var(--color-separator)] shadow-lg py-1 w-40"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              type="button"
              onClick={() => { void handleDelete(menu.id); setMenu(null); }}
              className="w-full text-left px-3 py-1.5 text-xs text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)]"
            >
              {t('session.delete')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

SessionList.displayName = 'SessionList';
