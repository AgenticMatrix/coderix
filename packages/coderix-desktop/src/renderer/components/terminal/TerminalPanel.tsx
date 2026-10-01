import { Plus, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n/index.js';
import Terminal from './Terminal.js';
import {
  closeTerminalSession,
  createTerminalSession,
  ensureWorkspaceTerminalState,
  exitTerminalSession,
  formatTerminalTabTitle,
  getNextTerminalSessionIndex,
  getTerminalSessionCloseAction,
  type TerminalPanelState,
} from './terminalPanelState.js';

export interface TerminalPanelProps {
  /** Whether the panel is open (visible). */
  isOpen: boolean;
  /** Called to toggle the panel open/closed. */
  onToggle: () => void;
  /** Current project directory, used as the workspace key + terminal cwd. */
  projectPath: string;
  /** Open an http(s) link in the embedded browser panel. */
  onOpenBrowserUrl: (url: string) => void;
}

function getPathLeaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * TerminalPanel — collapsible multi-tab terminal panel.
 *
 * Each tab owns an independent PTY. Closing the panel only collapses it (keeps
 * sessions alive); switching tabs keeps every terminal mounted so running
 * commands are not interrupted by a React remount. A PTY exit removes its tab.
 */
export default function TerminalPanel({
  isOpen,
  onToggle,
  projectPath,
  onOpenBrowserUrl,
}: TerminalPanelProps): React.ReactElement {
  const t = useT();
  const workspaceKey = projectPath || '__default__';
  const [panelState, setPanelState] = useState<TerminalPanelState>({
    sessions: {},
    workspaces: {},
  });

  // Lazily create a session for the workspace the first time the panel opens.
  useEffect(() => {
    if (!isOpen) return;
    setPanelState((current) =>
      ensureWorkspaceTerminalState(current, { workspaceKey, cwd: projectPath }),
    );
  }, [isOpen, workspaceKey, projectPath]);

  const handleShellLabelChange = useCallback((sessionId: string, shellLabel: string | null) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session || session.shellLabel === shellLabel) {
        return current;
      }
      return {
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: { ...session, shellLabel },
        },
      };
    });
  }, []);

  const handleCreateSession = useCallback(() => {
    setPanelState((current) => {
      const ensured = ensureWorkspaceTerminalState(current, { workspaceKey, cwd: projectPath });
      const workspace = ensured.workspaces[workspaceKey];
      if (!workspace) return ensured;

      const session = createTerminalSession({
        workspaceKey,
        cwd: projectPath,
        index: getNextTerminalSessionIndex(ensured, workspaceKey),
      });

      return {
        sessions: {
          ...ensured.sessions,
          [session.id]: session,
        },
        workspaces: {
          ...ensured.workspaces,
          [workspaceKey]: {
            sessionIds: [...workspace.sessionIds, session.id],
            activeSessionId: session.id,
          },
        },
      };
    });
  }, [workspaceKey, projectPath]);

  const handleCloseSession = useCallback(
    (sessionId: string) => {
      const closeAction = getTerminalSessionCloseAction(panelState, sessionId);
      if (closeAction === 'close-panel') {
        // The last tab's close collapses the panel and keeps the session alive,
        // matching the top-right close button's semantics.
        onToggle();
        return;
      }
      if (closeAction !== 'close-session') return;

      setPanelState((current) => closeTerminalSession(current, sessionId));
    },
    [panelState, onToggle],
  );

  const handleSessionExit = useCallback(
    (sessionId: string, _exitCode: number) => {
      setPanelState((current) => exitTerminalSession(current, sessionId, workspaceKey).state);
    },
    [workspaceKey],
  );

  const handleActivateSession = useCallback((sessionId: string) => {
    setPanelState((current) => {
      const session = current.sessions[sessionId];
      if (!session) return current;
      const workspace = current.workspaces[session.workspaceKey];
      if (!workspace || workspace.activeSessionId === sessionId) return current;
      return {
        ...current,
        workspaces: {
          ...current.workspaces,
          [session.workspaceKey]: {
            ...workspace,
            activeSessionId: sessionId,
          },
        },
      };
    });
  }, []);

  const workspace = panelState.workspaces[workspaceKey];
  const currentSessions =
    workspace?.sessionIds
      .map((sessionId) => panelState.sessions[sessionId])
      .filter((session): session is NonNullable<typeof session> => Boolean(session)) ?? [];
  const activeSession =
    currentSessions.find((session) => session.id === workspace?.activeSessionId) ??
    currentSessions[0] ??
    null;
  const allSessions = Object.values(panelState.sessions);

  const projectName = getPathLeaf(projectPath) || t('terminal.title');

  return (
    <div
      className="terminal-panel"
      style={{
        flex: isOpen ? '0 0 35%' : '0 0 0px',
        minHeight: isOpen ? '120px' : '0px',
        overflow: 'hidden',
        transition: 'flex 250ms cubic-bezier(0, 0, 0.58, 1), min-height 250ms cubic-bezier(0, 0, 0.58, 1)',
        borderTop: isOpen ? '1px solid var(--color-separator, rgba(0,0,0,0.08))' : 'none',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Tab bar + header */}
      {isOpen && (
        <div
          className="terminal-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 8px',
            height: '30px',
            flexShrink: 0,
            background: 'var(--color-bg-secondary, #F4F2EB)',
            borderBottom: '1px solid var(--color-separator, rgba(0,0,0,0.08))',
          }}
        >
          <div className="flex min-w-0 items-center gap-1">
            <span
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--color-text-secondary, #656358)',
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
                padding: '0 8px 0 4px',
              }}
            >
              {t('terminal.title')}
            </span>
            {activeSession?.shellLabel ? (
              <span className="shrink-0 text-[11px] text-[var(--color-text-tertiary)]">
                {activeSession.shellLabel}
              </span>
            ) : null}

            {/* Tabs */}
            <div className="ml-2 flex min-w-0 items-center gap-1 overflow-x-auto">
              {currentSessions.map((session) => {
                const isActive = session.id === activeSession?.id;
                const title = formatTerminalTabTitle(projectName, session.index);
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => handleActivateSession(session.id)}
                    title={title}
                    className="group flex shrink-0 items-center gap-1 rounded-t-[var(--radius-sm)] px-2 py-1 text-[11px]"
                    style={{
                      color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
                      background: isActive ? 'var(--color-bg-primary)' : 'transparent',
                      borderBottom: isActive ? '2px solid var(--color-brand)' : '2px solid transparent',
                    }}
                  >
                    <span className="max-w-[140px] truncate">{title}</span>
                    <span
                      role="button"
                      aria-label={t('terminal.closeTab', { title })}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseSession(session.id);
                      }}
                      className="flex h-3.5 w-3.5 items-center justify-center rounded hover:bg-[var(--color-bg-tertiary)]"
                    >
                      <X size={11} />
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={handleCreateSession}
                title={t('terminal.new')}
                aria-label={t('terminal.new')}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
              >
                <Plus size={13} />
              </button>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onToggle}
              title={t('terminal.close')}
              aria-label={t('terminal.close')}
              className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Terminal area — always mounted once created so PTYs survive tab switches
          and panel collapse; inactive/hidden terminals are display:none. */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: isOpen ? 'flex' : 'none',
          flexDirection: 'column',
          padding: '4px',
        }}
      >
        {allSessions.map((session) => {
          const visible = isOpen && session.id === activeSession?.id;
          return (
            <div
              key={session.id}
              style={{ display: visible ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}
            >
              <Terminal
                sessionId={session.id}
                cwd={session.cwd}
                isVisible={visible}
                onShellLabelChange={(label) => handleShellLabelChange(session.id, label)}
                onExit={(exitCode) => handleSessionExit(session.id, exitCode)}
                onOpenBrowserUrl={onOpenBrowserUrl}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

TerminalPanel.displayName = 'TerminalPanel';
