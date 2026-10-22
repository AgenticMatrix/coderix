import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamBlock } from '../../types.js';

vi.mock('../../ipc-client.js', () => ({
  onStreamBlock: vi.fn(),
  onStreamDone: vi.fn(),
  onStreamError: vi.fn(),
  onStreamTurnDone: vi.fn(),
  onTokenUsage: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  forkSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import {
  onStreamBlock,
  onStreamDone,
  onStreamError,
  onStreamTurnDone,
  onTokenUsage,
} from '../../ipc-client.js';
import { useChatStore } from '../chatStore.js';
import { useStreamStore } from '../streamStore.js';

type BlockCb = (block: StreamBlock) => void;
type DoneCb = (stopReason?: string, sessionId?: string) => void;
type TurnDoneCb = (sessionId?: string, epoch?: number) => void;
type ErrorCb = (error: string, code?: string, sessionId?: string, epoch?: number) => void;

let blockCb: BlockCb;
let doneCb: DoneCb;
let turnDoneCb: TurnDoneCb;
let errorCb: ErrorCb;

function flushFrame(): void {
  vi.advanceTimersByTime(1);
}

describe('streamStore turn lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { coderixAPI: {} });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));

    vi.mocked(onStreamBlock).mockImplementation((cb) => {
      blockCb = cb as BlockCb;
      return () => {};
    });
    vi.mocked(onStreamDone).mockImplementation((cb) => {
      doneCb = cb as DoneCb;
      return () => {};
    });
    vi.mocked(onStreamTurnDone).mockImplementation((cb) => {
      turnDoneCb = cb as TurnDoneCb;
      return () => {};
    });
    vi.mocked(onStreamError).mockImplementation((cb) => {
      errorCb = cb as ErrorCb;
      return () => {};
    });
    vi.mocked(onTokenUsage).mockImplementation(() => () => {});

    useChatStore.setState({
      messages: [],
      isStreaming: false,
      streamingContent: '',
      sessionId: 's1',
      error: null,
      messagesBySession: {},
      streamingBySession: {},
      streamEpochBySession: {},
    });
    useStreamStore.setState({
      currentMessage: null,
      currentMessageBySession: {},
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalCost: 0,
        currency: 'USD',
        contextTokens: 0,
      },
      tokenUsageBySession: {},
      _cleanups: [],
    });
    useStreamStore.getState().startListening();
  });

  afterEach(() => {
    useStreamStore.getState().stopListening();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('clears streaming on the matching turn epoch', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);

    blockCb({ type: 'text', content: 'hello', state: 'done', sessionId: 's1' });
    flushFrame();
    expect(useStreamStore.getState().currentMessage?.blocks.length).toBe(1);

    doneCb('end_turn', 's1');
    expect(useChatStore.getState().messages.length).toBe(2); // user + assistant

    turnDoneCb('s1', 1);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('ignores a stale turn epoch', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 2);

    turnDoneCb('s1', 1);
    expect(useChatStore.getState().isStreaming).toBe(true);
  });

  it('adopts a higher epoch instead of ignoring the end of the turn', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);

    turnDoneCb('s1', 3);
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(useChatStore.getState().streamEpochBySession.s1).toBe(3);
  });

  it('ends the turn when a terminal step is never followed by done', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);

    blockCb({ type: 'text', content: 'answer', state: 'done', sessionId: 's1' });
    flushFrame();
    doneCb('end_turn', 's1');
    expect(useChatStore.getState().isStreaming).toBe(true);

    vi.advanceTimersByTime(2600);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('does not end the turn early when another step starts', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);

    blockCb({ type: 'text', content: 'answer', state: 'done', sessionId: 's1' });
    flushFrame();
    doneCb('end_turn', 's1');

    // The engine starts another step (e.g. after a tool) before the grace ends.
    blockCb({ type: 'thinking', content: 'more', state: 'pending', sessionId: 's1' });
    vi.advanceTimersByTime(5000);
    expect(useChatStore.getState().isStreaming).toBe(true);
  });

  it('keeps the turn alive while a tool is still running', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);

    blockCb({ type: 'tool_use', toolId: 't1', toolName: 'Bash', state: 'executing', sessionId: 's1' });
    flushFrame();
    doneCb('end_turn', 's1');

    vi.advanceTimersByTime(5000);
    expect(useChatStore.getState().isStreaming).toBe(true);
  });

  it('clears streaming on an interrupt even for a background session', () => {
    useChatStore.setState({ sessionId: 's2', isStreaming: false });
    blockCb({ type: 'text', content: 'x', state: 'done', sessionId: 's1' });
    errorCb('Query interrupted by user', 'INTERRUPTED', 's1', 1);
    expect(useChatStore.getState().streamingBySession.s1).toBe(false);
  });
});
