import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionInfo } from '../../types.js';

vi.mock('../../ipc-client.js', () => ({
  listSessions: vi.fn(),
  getSession: vi.fn(),
  forkSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
}));

import { listSessions, getSession } from '../../ipc-client.js';
import { useSessionStore } from '../sessionStore.js';

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    title: '新对话',
    turnCount: 0,
    model: 'deepseek-flash',
    updatedAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

describe('sessionStore', () => {
  beforeEach(() => {
    // The store's actions guard on the preload API being present.
    vi.stubGlobal('window', { coderixAPI: { session: {} } });
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('loadSessions replaces the list with the backend view', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      sessionInfo({ id: 'old', updatedAt: 1 }),
      sessionInfo({ id: 'new', updatedAt: 2 }),
    ]);

    await useSessionStore.getState().loadSessions();

    // Ordered most-recent-first.
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('keeps the previous list when the backend read fails', async () => {
    useSessionStore.setState({
      sessions: [sessionInfo({ id: 'kept' })],
    });
    vi.mocked(listSessions).mockRejectedValue(new Error('IPC down'));

    await useSessionStore.getState().loadSessions();

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['kept']);
    expect(useSessionStore.getState().error).toBe('IPC down');
  });

  it('refreshSession upserts a conversation that is missing from the list', async () => {
    // A full list reload can drop a session created before its first message
    // was persisted. The post-turn refresh must bring it back.
    vi.mocked(getSession).mockResolvedValue(
      sessionInfo({ id: 'recovered', title: '你好', turnCount: 2, updatedAt: 5 }),
    );

    await useSessionStore.getState().refreshSession('recovered');

    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(['recovered']);
    expect(useSessionStore.getState().sessions[0]?.title).toBe('你好');
  });

  it('refreshSession patches an existing entry without dropping others', async () => {
    useSessionStore.setState({
      sessions: [
        sessionInfo({ id: 'a', title: 'A', updatedAt: 2 }),
        sessionInfo({ id: 'b', title: 'B', updatedAt: 1 }),
      ],
    });
    vi.mocked(getSession).mockResolvedValue(
      sessionInfo({ id: 'a', title: 'A2', turnCount: 4, updatedAt: 3 }),
    );

    await useSessionStore.getState().refreshSession('a');

    const sessions = useSessionStore.getState().sessions;
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(sessions[0]?.title).toBe('A2');
    expect(sessions[0]?.turnCount).toBe(4);
  });

  it('setSessionWorkDir patches the workspace in place', () => {
    useSessionStore.setState({
      sessions: [
        sessionInfo({ id: 'a', workDir: '/old' }),
        sessionInfo({ id: 'b', workDir: '/other' }),
      ],
    });

    useSessionStore.getState().setSessionWorkDir('a', '/new/workspace');

    const sessions = useSessionStore.getState().sessions;
    expect(sessions.find((s) => s.id === 'a')?.workDir).toBe('/new/workspace');
    expect(sessions.find((s) => s.id === 'b')?.workDir).toBe('/other');
  });
});
