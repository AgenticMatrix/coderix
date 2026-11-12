import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../chatStore.js';

const reset = (): void => {
  useChatStore.setState({
    messages: [],
    isStreaming: false,
    streamingContent: '',
    sessionId: null,
    error: null,
    interrupted: false,
    messagesBySession: {},
    streamingBySession: {},
    errorBySession: {},
    interruptedBySession: {},
    streamEpochBySession: {},
    historyCursorBySession: {},
    hasMoreHistoryBySession: {},
    loadingHistoryBySession: {},
    loadingHistory: false,
  });
};

beforeEach(reset);

describe('per-session terminal markers', () => {
  it('stashes the viewed session’s busy flag so its row stays busy', () => {
    useChatStore.setState({ sessionId: 's1', isStreaming: true });
    useChatStore.getState().setSessionId('s2');
    expect(useChatStore.getState().streamingBySession.s1).toBe(true);
  });

  it('carries an error to the session map and restores it on switch-in', () => {
    useChatStore.setState({ sessionId: 's1' });
    useChatStore.getState().setError('boom');
    useChatStore.getState().setSessionId('s2');
    expect(useChatStore.getState().errorBySession.s1).toBe('boom');

    useChatStore.getState().setSessionId('s1');
    expect(useChatStore.getState().error).toBe('boom');
  });

  it('carries an interrupt to the session map and restores it on switch-in', () => {
    useChatStore.setState({ sessionId: 's1', isStreaming: true });
    useChatStore.getState().interruptStream();
    useChatStore.getState().setSessionId('s2');
    expect(useChatStore.getState().interruptedBySession.s1).toBe(true);

    useChatStore.getState().setSessionId('s1');
    expect(useChatStore.getState().interrupted).toBe(true);
  });
});

describe('setSessionError', () => {
  it('writes the map slot for a backgrounded session', () => {
    useChatStore.setState({ sessionId: 's2' });
    useChatStore.getState().setSessionError('s1', 'oops');
    expect(useChatStore.getState().errorBySession.s1).toBe('oops');
    // The viewed session's banner is untouched.
    expect(useChatStore.getState().error).toBeNull();

    useChatStore.getState().setSessionError('s1', null);
    expect(useChatStore.getState().errorBySession.s1).toBeUndefined();
  });

  it('never touches the turn lifecycle of the viewed session', () => {
    useChatStore.setState({ sessionId: 's1', isStreaming: true });
    useChatStore.getState().setSessionError('s1', null);
    expect(useChatStore.getState().isStreaming).toBe(true);
  });
});

describe('interruptStream on a backgrounded session', () => {
  it('marks interrupted only when a turn was actually running', () => {
    useChatStore.setState({ sessionId: 's2', streamingBySession: { s1: true } });
    useChatStore.getState().interruptStream('s1');
    expect(useChatStore.getState().streamingBySession.s1).toBe(false);
    expect(useChatStore.getState().interruptedBySession.s1).toBe(true);

    useChatStore.getState().clearInterrupted('s1');
    expect(useChatStore.getState().interruptedBySession.s1).toBeUndefined();
  });

  it('does not mark an idle session', () => {
    useChatStore.setState({ sessionId: 's2', streamingBySession: { s1: false } });
    useChatStore.getState().interruptStream('s1');
    expect(useChatStore.getState().interruptedBySession.s1).toBeUndefined();
  });
});
describe('history paging', () => {
  const msg = (id: string) => ({
    id,
    role: 'user' as const,
    content: '',
    blocks: [],
    timestamp: 0,
  });

  it('installs a tail page with its cursor and clears the loading flag', () => {
    useChatStore.setState({ sessionId: 's1', loadingHistory: true });
    useChatStore.getState().setSessionTranscript('s1', [msg('a'), msg('b')], {
      oldestUuid: 'a',
      hasMore: true,
    });
    const s = useChatStore.getState();
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(s.historyCursorBySession.s1).toBe('a');
    expect(s.hasMoreHistoryBySession.s1).toBe(true);
    expect(s.loadingHistory).toBe(false);
  });

  it('prepends an older page without dropping the newer one', () => {
    useChatStore.setState({ sessionId: 's1' });
    useChatStore.getState().setSessionTranscript('s1', [msg('c'), msg('d')], {
      oldestUuid: 'c',
      hasMore: true,
    });
    useChatStore.getState().prependSessionMessages('s1', [msg('a'), msg('b')], {
      oldestUuid: 'a',
      hasMore: false,
    });
    const s = useChatStore.getState();
    expect(s.messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(s.historyCursorBySession.s1).toBe('a');
    expect(s.hasMoreHistoryBySession.s1).toBe(false);
  });

  it('keeps a backgrounded session’s window and cursor when switching away', () => {
    useChatStore.setState({ sessionId: 's1' });
    useChatStore.getState().setSessionTranscript('s1', [msg('x')], {
      oldestUuid: 'x',
      hasMore: true,
    });
    useChatStore.getState().setSessionId('s2');
    expect(useChatStore.getState().hasMoreHistoryBySession.s1).toBe(true);

    useChatStore.getState().setSessionId('s1');
    // The cached transcript returns intact — re-opening must not silently
    // collapse the window back to a fresh tail page.
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['x']);
    expect(useChatStore.getState().historyCursorBySession.s1).toBe('x');
  });

  it('does not inherit another session’s loading flag on switch', () => {
    useChatStore.setState({ sessionId: 's1', loadingHistoryBySession: { s1: true }, loadingHistory: true });
    useChatStore.getState().setSessionId('s2');
    expect(useChatStore.getState().loadingHistory).toBe(false);
  });
});

describe('history paging edge cases', () => {
  const msg = (id: string) => ({ id, role: 'user' as const, content: '', blocks: [], timestamp: 0 });

  it('stops paging once the oldest page reports no more', () => {
    useChatStore.setState({ sessionId: 's1' });
    useChatStore.getState().setSessionTranscript('s1', [msg('b')], { oldestUuid: 'b', hasMore: true });
    useChatStore.getState().prependSessionMessages('s1', [msg('a')], { oldestUuid: 'a', hasMore: false });
    const s = useChatStore.getState();
    expect(s.hasMoreHistoryBySession.s1).toBe(false);
    // A later prepend that discovers more can re-open paging.
    useChatStore.getState().prependSessionMessages('s1', [msg('z')], { oldestUuid: 'z', hasMore: true });
    expect(useChatStore.getState().hasMoreHistoryBySession.s1).toBe(true);
  });

  it('a short session records no cursor and no more pages', () => {
    useChatStore.setState({ sessionId: 's1' });
    useChatStore.getState().setSessionTranscript('s1', [msg('only')], { oldestUuid: 'only', hasMore: false });
    const s = useChatStore.getState();
    expect(s.hasMoreHistoryBySession.s1).toBe(false);
    expect(s.historyCursorBySession.s1).toBe('only');
  });
});
