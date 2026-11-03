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