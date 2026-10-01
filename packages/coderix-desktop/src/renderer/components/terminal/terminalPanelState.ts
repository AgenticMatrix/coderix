export interface TerminalSessionDescriptor {
  id: string;
  workspaceKey: string;
  cwd?: string;
  index: number;
  shellLabel: string | null;
}

export interface TerminalWorkspaceState {
  sessionIds: string[];
  activeSessionId: string;
}

export interface TerminalPanelState {
  sessions: Record<string, TerminalSessionDescriptor>;
  workspaces: Record<string, TerminalWorkspaceState>;
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createTerminalSession(params: {
  workspaceKey: string;
  cwd?: string;
  index: number;
}): TerminalSessionDescriptor {
  return {
    id: createSessionId(),
    workspaceKey: params.workspaceKey,
    cwd: params.cwd,
    index: params.index,
    shellLabel: null,
  };
}

export function createWorkspaceTerminalState(params: {
  workspaceKey: string;
  cwd?: string;
}): {
  session: TerminalSessionDescriptor;
  workspace: TerminalWorkspaceState;
} {
  const session = createTerminalSession({
    workspaceKey: params.workspaceKey,
    cwd: params.cwd,
    index: 1,
  });

  return {
    session,
    workspace: {
      sessionIds: [session.id],
      activeSessionId: session.id,
    },
  };
}

export function getNextTerminalSessionIndex(
  state: TerminalPanelState,
  workspaceKey: string,
): number {
  const workspace = state.workspaces[workspaceKey];
  const usedIndices = new Set(
    workspace?.sessionIds
      .map((sessionId) => state.sessions[sessionId]?.index)
      .filter((index): index is number => typeof index === 'number') ?? [],
  );

  for (let index = 1; ; index += 1) {
    if (!usedIndices.has(index)) {
      return index;
    }
  }
}

export function formatTerminalTabTitle(projectName: string, index: number): string {
  return index === 1 ? projectName : `${projectName} ${index}`;
}

type TerminalSessionCloseAction = 'none' | 'close-panel' | 'close-session';

interface TerminalSessionExitResult {
  state: TerminalPanelState;
  action: TerminalSessionCloseAction;
}

export function getTerminalSessionCloseAction(
  state: TerminalPanelState,
  sessionId: string,
): TerminalSessionCloseAction {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return 'none';
  }

  return workspace.sessionIds.length === 1 ? 'close-panel' : 'close-session';
}

export function closeTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
): TerminalPanelState {
  if (getTerminalSessionCloseAction(state, sessionId) !== 'close-session') {
    return state;
  }

  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace) {
    return state;
  }

  const closingIndex = workspace.sessionIds.indexOf(sessionId);
  const nextSessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
  const fallbackSessionId = nextSessionIds[Math.max(0, closingIndex - 1)] ?? nextSessionIds[0];
  if (!fallbackSessionId) {
    return state;
  }

  const { [sessionId]: _closedSession, ...nextSessions } = state.sessions;
  return {
    sessions: nextSessions,
    workspaces: {
      ...state.workspaces,
      [session.workspaceKey]: {
        sessionIds: nextSessionIds,
        activeSessionId:
          workspace.activeSessionId === sessionId ? fallbackSessionId : workspace.activeSessionId,
      },
    },
  };
}

export function exitTerminalSession(
  state: TerminalPanelState,
  sessionId: string,
  activeWorkspaceKey: string,
): TerminalSessionExitResult {
  const session = state.sessions[sessionId];
  const workspace = session ? state.workspaces[session.workspaceKey] : undefined;
  if (!session || !workspace?.sessionIds.includes(sessionId)) {
    return { state, action: 'none' };
  }

  if (workspace.sessionIds.length > 1) {
    return {
      state: closeTerminalSession(state, sessionId),
      action: 'close-session',
    };
  }

  // When the PTY itself exited, the last tab can't just collapse-and-keep like a
  // manual close — remove its records; reopening the workspace lazily creates a
  // fresh PTY.
  const { [sessionId]: _exitedSession, ...nextSessions } = state.sessions;
  const { [session.workspaceKey]: _exitedWorkspace, ...nextWorkspaces } = state.workspaces;
  return {
    state: {
      sessions: nextSessions,
      workspaces: nextWorkspaces,
    },
    action: session.workspaceKey === activeWorkspaceKey ? 'close-panel' : 'close-session',
  };
}

export function ensureWorkspaceTerminalState(
  state: TerminalPanelState,
  params: {
    workspaceKey: string;
    cwd?: string;
  },
): TerminalPanelState {
  const existingWorkspace = state.workspaces[params.workspaceKey];
  if (existingWorkspace?.sessionIds.some((sessionId) => state.sessions[sessionId])) {
    return state;
  }

  const { session, workspace } = createWorkspaceTerminalState(params);
  return {
    sessions: {
      ...state.sessions,
      [session.id]: session,
    },
    workspaces: {
      ...state.workspaces,
      [params.workspaceKey]: workspace,
    },
  };
}
