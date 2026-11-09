import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamBlock } from '../../types.js';

vi.mock('../../ipc-client.js', () => ({
  onStreamBlock: vi.fn(),
  onStreamCompact: vi.fn(),
  onStreamDone: vi.fn(),
  onStreamError: vi.fn(),
  onStreamPhase: vi.fn(),
  onStreamRetry: vi.fn(),
  onStreamTasks: vi.fn(),
  onStreamTurnDone: vi.fn(),
  onTokenUsage: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  forkSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import {
  onStreamBlock,
  onStreamCompact,
  onStreamDone,
  onStreamError,
  onStreamPhase,
  onStreamRetry,
  onStreamTasks,
  onStreamTurnDone,
  onTokenUsage,
  type RunningTaskSummary,
} from '../../ipc-client.js';
import { useChatStore } from '../chatStore.js';
import { useStreamStore } from '../streamStore.js';

type BlockCb = (block: StreamBlock) => void;
type DoneCb = (stopReason?: string, sessionId?: string) => void;
type TurnDoneCb = (sessionId?: string, epoch?: number) => void;
type ErrorCb = (error: string, code?: string, sessionId?: string, epoch?: number) => void;
type TokenCb = (
  stats: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cost?: number;
    currency?: string;
    contextTokens?: number;
    contextOnly?: boolean;
  },
  sessionId?: string,
) => void;

let blockCb: BlockCb;
let doneCb: DoneCb;
let turnDoneCb: TurnDoneCb;
let errorCb: ErrorCb;
let retryCb: (notice: { attempt: number; maxRetries: number; delayMs: number; message: string; errorClass: string; sessionId?: string }) => void;
let tokenCb: TokenCb;
let phaseCb: (sessionId?: string) => void;
let tasksCb: (tasks: RunningTaskSummary[], sessionId?: string) => void;
let compactCb: (compacting: boolean, sessionId?: string) => void;

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
    vi.mocked(onStreamRetry).mockImplementation((cb) => {
      retryCb = cb as typeof retryCb;
      return () => {};
    });
    vi.mocked(onTokenUsage).mockImplementation((cb) => {
      tokenCb = cb as TokenCb;
      return () => {};
    });
    vi.mocked(onStreamPhase).mockImplementation((cb) => {
      phaseCb = cb;
      return () => {};
    });
    vi.mocked(onStreamTasks).mockImplementation((cb) => {
      tasksCb = cb;
      return () => {};
    });
    vi.mocked(onStreamCompact).mockImplementation((cb) => {
      compactCb = cb;
      return () => {};
    });

    useChatStore.setState({
      messages: [],
      isStreaming: false,
      streamingContent: '',
      sessionId: 's1',
      error: null,
      interrupted: false,
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
      requestingBySession: {},
      runningTasksBySession: {},
      compactingBySession: {},
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

  it('stays in the turn when a terminal step is never followed by done', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);

    blockCb({ type: 'text', content: 'answer', state: 'done', sessionId: 's1' });
    flushFrame();
    doneCb('end_turn', 's1');

    // message_stop only commits the step. Ending the turn is the engine's job
    // (or, when it ends silently, the main process's TURN_INCOMPLETE error) —
    // the renderer must not invent an idle state on a timer any more.
    vi.advanceTimersByTime(5000);
    expect(useChatStore.getState().isStreaming).toBe(true);
  });

  it('does not end the turn when another step starts', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);

    blockCb({ type: 'text', content: 'answer', state: 'done', sessionId: 's1' });
    flushFrame();
    doneCb('end_turn', 's1');

    // The engine starts another step (e.g. after a tool).
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

  it('marks a session requesting until its first block arrives', () => {
    useChatStore.getState().sendMessage('hi');

    phaseCb('s1');
    expect(useStreamStore.getState().requestingBySession.s1).toBe(true);

    blockCb({ type: 'thinking', content: 'hm', state: 'pending', sessionId: 's1' });
    expect(useStreamStore.getState().requestingBySession.s1).toBeUndefined();
  });

  it('keeps the turn alive when a retry notice arrives', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);
    useChatStore.getState().setSessionStreaming('s1', true);

    retryCb({
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
      message: '429 rate limit exceeded',
      errorClass: 'rate_limit',
      sessionId: 's1',
    });

    // A retry is advisory: the turn is still running, so nothing may be torn
    // down and no error may be surfaced.
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().errorBySession?.s1 ?? null).toBeNull();
    // The status bar should read "waiting on the model" during the backoff gap.
    expect(useStreamStore.getState().requestingBySession.s1).toBe(true);
  });

  it('lets the retried answer render after a retry notice', () => {
    useChatStore.getState().sendMessage('hi');
    useChatStore.getState().setStreamEpoch('s1', 1);
    useChatStore.getState().setSessionStreaming('s1', true);

    retryCb({
      attempt: 1,
      maxRetries: 3,
      delayMs: 0,
      message: '503 unavailable',
      errorClass: 'server_error',
      sessionId: 's1',
    });

    // The blocks of the successful retry must still be accepted. If the retry
    // notice had been treated as an error, isStreaming would be false and
    // onStreamBlock would drop this block on the floor.
    blockCb({ type: 'text', content: 'recovered answer', state: 'done', sessionId: 's1' });
    flushFrame();

    const msg = useStreamStore.getState().currentMessage;
    expect(msg?.blocks.length).toBe(1);
    expect(msg?.blocks[0]).toMatchObject({ type: 'text', content: 'recovered answer' });
  });

  it('tracks the running background task list per session', () => {
    const tasks: RunningTaskSummary[] = [
      { id: 'bash-1', type: 'bash', description: 'npm test', startedAt: 1 },
    ];
    tasksCb(tasks, 's1');
    expect(useStreamStore.getState().runningTasksBySession.s1).toHaveLength(1);

    tasksCb([], 's1');
    expect(useStreamStore.getState().runningTasksBySession.s1).toBeUndefined();
  });

  it('tracks context compaction per session', () => {
    compactCb(true, 's1');
    expect(useStreamStore.getState().compactingBySession.s1).toBe(true);

    compactCb(false, 's1');
    expect(useStreamStore.getState().compactingBySession.s1).toBeUndefined();
  });

  it('drops the interrupt marker when the turn finishes on its own', () => {
    useChatStore.setState({ isStreaming: true });
    errorCb('Query interrupted by user', 'INTERRUPTED', 's1', 1);
    expect(useChatStore.getState().interrupted).toBe(true);

    turnDoneCb('s1', 1);
    expect(useChatStore.getState().interrupted).toBe(false);
  });

  it('does not mark an interrupt when nothing was running', () => {
    useChatStore.getState().interruptStream('s1');
    expect(useChatStore.getState().interrupted).toBe(false);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('leaves the viewed session alone when another session aborts', () => {
    useChatStore.setState({ sessionId: 's2' });
    errorCb('Query interrupted by user', 'INTERRUPTED', 's1', 1);
    expect(useChatStore.getState().interrupted).toBe(false);
  });

  it('marks the viewed session interrupted when the engine reports an abort', () => {
    useChatStore.setState({ isStreaming: true });
    errorCb('Query interrupted by user', 'INTERRUPTED', 's1', 1);
    expect(useChatStore.getState().interrupted).toBe(true);

    // A new turn clears the marker with the error.
    useChatStore.getState().sendMessage('next');
    expect(useChatStore.getState().interrupted).toBe(false);
  });

  it('ignores a superseded turn\u2019s late interrupt', () => {
    // Sending a second message aborts the first turn's controller in the main
    // process, and that aborted turn reports INTERRUPTED even though the user
    // never pressed stop. Its signal carries the OLD epoch, so it must not
    // clear the marker or the streaming state of the turn now running.
    useChatStore.getState().sendMessage('first');
    useChatStore.getState().setStreamEpoch('s1', 1);
    useChatStore.getState().sendMessage('second');
    useChatStore.getState().setStreamEpoch('s1', 2);

    errorCb('Query interrupted by user', 'INTERRUPTED', 's1', 1);

    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().interrupted).toBe(false);
    expect(useChatStore.getState().errorBySession?.s1 ?? null).toBeNull();
  });

  it('adopts a live context footprint without touching billable totals', () => {
    tokenCb({ inputTokens: 10, outputTokens: 5, contextTokens: 42000 }, 's1');
    expect(useStreamStore.getState().tokenUsage.contextTokens).toBe(42000);
    expect(useStreamStore.getState().tokenUsage.inputTokens).toBe(10);

    tokenCb({ contextTokens: 48000, contextOnly: true }, 's1');
    const usage = useStreamStore.getState().tokenUsage;
    expect(usage.contextTokens).toBe(48000);
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
  });

  it('keeps the last footprint when a turn reports none', () => {
    tokenCb({ contextTokens: 42000, contextOnly: true }, 's1');
    tokenCb({ inputTokens: 7, outputTokens: 1 }, 's1');
    expect(useStreamStore.getState().tokenUsage.contextTokens).toBe(42000);
  });

  it('clears streaming on an interrupt even for a background session', () => {
    useChatStore.setState({ sessionId: 's2', isStreaming: false });
    blockCb({ type: 'text', content: 'x', state: 'done', sessionId: 's1' });
    errorCb('Query interrupted by user', 'INTERRUPTED', 's1', 1);
    expect(useChatStore.getState().streamingBySession.s1).toBe(false);
  });
});
