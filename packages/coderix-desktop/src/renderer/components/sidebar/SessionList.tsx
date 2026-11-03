import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { List, Folder, ChevronRight, Monitor, Terminal } from 'lucide-react';
import { useSessionStore } from '../../store/sessionStore.js';
import { useChatStore } from '../../store/chatStore.js';
import { useStreamStore } from '../../store/streamStore.js';
import { useSubagentStore } from '../../store/subagentStore.js';
import { deriveSessionRowStatus, type SessionListStatus } from '../../session-status.js';
import { countSessionRunningAgents } from '../../agent-status.js';
import { useT, formatRelativeTime } from '../../i18n/index.js';
import type { SessionSummary } from '../../store/types.js';

export interface SessionListProps {
  activeSessionId?: string;
  onSessionSelect?: (sessionId: string) => void;
  searchQuery?: string;
}

type ViewMode = 'flat' | 'workspace';

/** Stable empty set used when every running agent already carries a session id. */
const NO_TOOL_IDS: ReadonlySet<string> = new Set();

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

/**
 * Live status dot shown at the bottom-right of a conversation row. The colours
 * mirror the bottom status bar (red = working/failed, yellow = waiting, green =
 * idle, grey = stopped) so the row and the bar never read as two states.
 */
const STATUS_META: Record<
  SessionListStatus,
  {
    labelKey:
      | 'session.status.busy'
      | 'session.status.wait'
      | 'session.status.idle'
      | 'session.status.error'
      | 'session.status.interrupted';
    hintKey:
      | 'session.status.busyHint'
      | 'session.status.waitHint'
      | 'session.status.backgroundHint'
      | 'session.status.idleHint'
      | 'session.status.errorHint'
      | 'session.status.interruptedHint';
    dot: string;
    text: string;
    pulse: boolean;
  }
> = {
  busy: {
    labelKey: 'session.status.busy',
    hintKey: 'session.status.busyHint',
    dot: 'bg-[var(--color-danger)]',
    text: 'text-[var(--color-danger)]',
    pulse: true,
  },
  wait: {
    labelKey: 'session.status.wait',
    hintKey: 'session.status.waitHint',
    dot: 'bg-[var(--color-warning)]',
    text: 'text-[var(--color-warning)]',
    pulse: true,
  },
  // The turn is over and only background tasks are draining: the user can keep
  // typing, so it reads "waiting" (yellow) rather than the red busy badge, and
  // does not pulse because nothing is waiting on the user.
  background: {
    labelKey: 'session.status.wait',
    hintKey: 'session.status.backgroundHint',
    dot: 'bg-[var(--color-warning)]',
    text: 'text-[var(--color-warning)]',
    pulse: false,
  },
  idle: {
    labelKey: 'session.status.idle',
    hintKey: 'session.status.idleHint',
    // Same green as the bottom bar's idle badge.
    dot: 'bg-[var(--color-success)]',
    text: 'text-[var(--color-success)]',
    pulse: false,
  },
  // Terminal outcomes: the bar already shows red "错误" / grey "已中断", and
  // nothing is running, so the dot does not pulse.
  error: {
    labelKey: 'session.status.error',
    hintKey: 'session.status.errorHint',
    dot: 'bg-[var(--color-danger)]',
    text: 'text-[var(--color-danger)]',
    pulse: false,
  },
  interrupted: {
    labelKey: 'session.status.interrupted',
    hintKey: 'session.status.interruptedHint',
    dot: 'bg-[var(--color-text-tertiary)]',
    text: 'text-[var(--color-text-tertiary)]',
    pulse: false,
  },
};

/**
 * The row badge is derived by the same function as the bottom status bar — see
 * deriveSessionRowStatus. The viewed session reads the flat slots, every other
 * session reads its own map slots, but the derivation (and therefore the badge
 * for a given state) is identical. That is what stops a conversation changing
 * badge merely because the user clicked away from it.
 */
export function SessionStatusBadge({
  status,
}: {
  status: SessionListStatus;
}): React.ReactElement {
  const t = useT();
  const meta = STATUS_META[status];
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
          meta.pulse ? 'animate-pulse' : ''
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
}: SessionListProps): React.ReactElement {
  const t = useT();
  const sessions = useSessionStore((s) => s.sessions);
  const isLoading = useSessionStore((s) => s.isLoading);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  // Live status sources. The viewed session keeps its live state in the flat
  // slots; backgrounded sessions keep theirs (and all stream phases) in the
  // per-session maps. Both feed the same derivation (deriveSessionRowStatus).
  const viewedSessionId = useChatStore((s) => s.sessionId);
  const viewedStreaming = useChatStore((s) => s.isStreaming);
  const viewedMessages = useChatStore((s) => s.messages);
  const viewedError = useChatStore((s) => s.error);
  const viewedInterrupted = useChatStore((s) => s.interrupted);
  const streamingBySession = useChatStore((s) => s.streamingBySession);
  const messagesBySession = useChatStore((s) => s.messagesBySession);
  const errorBySession = useChatStore((s) => s.errorBySession);
  const interruptedBySession = useChatStore((s) => s.interruptedBySession);
  const viewedCurrentMessage = useStreamStore((s) => s.currentMessage);
  const runningTasksBySession = useStreamStore((s) => s.runningTasksBySession);
  const currentMessageBySession = useStreamStore((s) => s.currentMessageBySession);
  const requestingBySession = useStreamStore((s) => s.requestingBySession);
  const compactingBySession = useStreamStore((s) => s.compactingBySession);
  const awaitingUserBySession = useStreamStore((s) => s.awaitingUserBySession);
  const subagentAgents = useSubagentStore((s) => s.agents);
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
    // One derivation for every row, fed from whichever slot owns the session:
    // flat for the viewed one, its per-session maps otherwise. A backgrounded
    // session used to lack the blocks/terminal markers, so its badge collapsed
    // to 等待 the moment it was clicked away from; now both slots carry every
    // input the bar uses, including an in-flight tool (工具执行中).
    const isViewed = session.id === viewedSessionId;
    const sessionMessages = isViewed
      ? viewedMessages
      : (messagesBySession[session.id] ?? []);
    const sessionCurrent = isViewed
      ? viewedCurrentMessage
      : (currentMessageBySession[session.id] ?? null);
    // Sub-agents are process-wide; match them by their owning session id. Only
    // records from engines that don't tag ownership need the transcript scan
    // (the spawner's tool_use id — see countSessionRunningAgents).
    let runningAgentCount = 0;
    const runningAgents = Object.values(subagentAgents).filter((a) => a.status === 'running');
    if (runningAgents.length > 0) {
      let toolIds: ReadonlySet<string> = NO_TOOL_IDS;
      if (runningAgents.some((a) => a.sessionId === undefined)) {
        const ids = new Set<string>();
        for (const message of sessionMessages) {
          for (const block of message.blocks) {
            if (block.type === 'tool_use' && block.toolId) ids.add(block.toolId);
          }
        }
        for (const block of sessionCurrent?.blocks ?? []) {
          if (block.type === 'tool_use' && block.toolId) ids.add(block.toolId);
        }
        toolIds = ids;
      }
      runningAgentCount = countSessionRunningAgents(subagentAgents, toolIds, session.id);
    }
    const status = deriveSessionRowStatus({
      isStreaming: isViewed ? viewedStreaming : Boolean(streamingBySession[session.id]),
      currentMessage: sessionCurrent,
      messages: sessionMessages,
      awaitingUser: Boolean(awaitingUserBySession[session.id]),
      compacting: Boolean(compactingBySession[session.id]),
      interrupted: isViewed ? viewedInterrupted : Boolean(interruptedBySession[session.id]),
      hasError: isViewed ? viewedError !== null : Boolean(errorBySession[session.id]),
      requesting: Boolean(requestingBySession[session.id]),
      runningTaskCount: runningTasksBySession[session.id]?.length ?? 0,
      runningAgentCount,
    });
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
