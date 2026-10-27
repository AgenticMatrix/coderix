/**
 * Terminal-event rules of the real `query:submit` handler.
 *
 * These drive the actual bridge (not a re-implementation) with a fake engine so
 * the three ways a turn can end stay distinguishable:
 *   - a real `done`                    → stream:turnDone
 *   - an engine-reported failure       → stream:error with the engine's code
 *   - a stream that just stops         → stream:error TURN_INCOMPLETE
 *   - a user interrupt                 → stream:error INTERRUPTED only
 *
 * The last two used to collapse into "the turn ended", which made a stalled
 * provider indistinguishable from a finished answer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const ipcHandlers = new Map<string, (...args: any[]) => any>();
const sent: Array<{ channel: string; data: any }> = [];

vi.mock('electron', () => {
  const ipcMain = {
    handle: (channel: string, fn: (...args: any[]) => any) => {
      ipcHandlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel);
    },
    on: () => {},
    removeListener: () => {},
  };
  const app = {
    getPath: () => '/tmp/coderix-terminal-events-test',
    getVersion: () => '0.0.0-test',
    getName: () => 'coderix-test',
    on: () => {},
    whenReady: async () => {},
    quit: () => {},
    isPackaged: false,
  };
  return {
    ipcMain,
    ipcRenderer: { on: () => {}, removeListener: () => {}, invoke: async () => undefined },
    contextBridge: { exposeInMainWorld: () => {}, exposeInIsolatedWorld: () => {} },
    BrowserWindow: class {},
    app,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
    default: { ipcMain, app },
  };
});

// The bridge imports the SDK engine; swap it for whatever the test stages.
const engineFactory: { current: ((opts: any) => AsyncGenerator<any>) | null } = { current: null };
vi.mock('../claude-code-engine.js', () => ({
  runClaudeCodeQuery: (opts: any) => engineFactory.current!(opts),
  getClaudeSessionId: () => undefined,
  getClaudeCumulativeUsage: () => undefined,
  loadClaudeSubagentTranscript: async () => [],
}));

vi.mock('../claude-code-runtime.js', () => ({
  claudeCodeRuntimeStatus: async () => ({ status: 'installed' }),
  ensureClaudeCodeInstalled: async () => ({ status: 'installed' }),
}));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error('timed out waiting for stream events');
}

const sentOn = (channel: string) => sent.filter((e) => e.channel === channel).map((e) => e.data);

/** A stream that yields `steps`, then either ends or blocks until aborted. */
function stageStream(
  steps: any[],
  options: { waitForAbort?: boolean } = {},
): (opts: any) => AsyncGenerator<any> {
  return (opts: any) =>
    (async function* () {
      for (const step of steps) yield step;
      if (options.waitForAbort) {
        await new Promise<void>((resolve) =>
          opts.abortController.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
    })() as AsyncGenerator<any>;
}

let sessionManager: any;
let bridge: any;

beforeAll(async () => {
  const core: any = await import('@coderix/core');
  const { createIpcBridge } = await import('../ipc-bridge.js');

  sessionManager = new core.SessionManager(true);
  const bus = {
    toolRequests: core.createSubject(),
    engineEvents: core.createSubject(),
    respondToTool: () => {},
  };
  const win = {
    webContents: {
      send: (channel: string, data: any) => sent.push({ channel, data }),
      isDestroyed: () => false,
    },
    isDestroyed: () => false,
  };

  bridge = createIpcBridge({
    windowManager: { getMainWindow: () => win },
    fileWatcher: {},
    terminalManager: {},
    sessionManager,
    workDir: '/tmp',
    model: 'test-model',
    eventBus: bus,
  } as any);
  bridge.setEngine('claude-code');
});

afterAll(() => {
  bridge?.destroy?.();
});

beforeEach(() => {
  sent.length = 0;
  sessionManager.create({ title: `probe-${Date.now()}`, cwd: '/tmp', model: 'test-model' });
});

describe('query:submit terminal events', () => {
  it('reports TURN_INCOMPLETE when the stream stops without a terminal event', async () => {
    engineFactory.current = stageStream([
      { type: 'message', data: { type: 'stream_event', event: { type: 'request_start' } } },
    ]);

    await ipcHandlers.get('query:submit')!({}, { query: 'hi' });
    await waitFor(() => sentOn('stream:error').length > 0);

    expect(sentOn('stream:turnDone')).toEqual([]);
    expect(sentOn('stream:error')).toHaveLength(1);
    expect(sentOn('stream:error')[0].code).toBe('TURN_INCOMPLETE');
    // The request-start signal reached the renderer as a phase event.
    expect(sentOn('stream:phase')[0]).toMatchObject({ phase: 'requesting' });
  });

  it('reports turnDone (and no error) for a real done', async () => {
    engineFactory.current = stageStream([
      { type: 'message', data: { type: 'stream_event', event: { type: 'request_start' } } },
      { type: 'done', data: { result: 'ok', stopReason: 'end_turn' } },
    ]);

    await ipcHandlers.get('query:submit')!({}, { query: 'hi' });
    await waitFor(() => sentOn('stream:turnDone').length > 0);

    expect(sentOn('stream:error')).toEqual([]);
    expect(sentOn('stream:turnDone')).toHaveLength(1);
  });

  it('surfaces an engine-reported error without also ending the turn', async () => {
    engineFactory.current = stageStream([
      { type: 'message', data: { type: 'stream_event', event: { type: 'request_start' } } },
      { type: 'error', data: { message: 'model never responded', code: 'IDLE_TIMEOUT' } },
    ]);

    await ipcHandlers.get('query:submit')!({}, { query: 'hi' });
    await waitFor(() => sentOn('stream:error').length > 0);

    expect(sentOn('stream:error')).toHaveLength(1);
    expect(sentOn('stream:error')[0].code).toBe('IDLE_TIMEOUT');
    expect(sentOn('stream:turnDone')).toEqual([]);
  });

  it('keeps a user interrupt separate from a failure', async () => {
    engineFactory.current = stageStream(
      [{ type: 'message', data: { type: 'stream_event', event: { type: 'request_start' } } }],
      { waitForAbort: true },
    );

    await ipcHandlers.get('query:submit')!({}, { query: 'hi' });
    await waitFor(() => sentOn('stream:phase').length > 0);

    await ipcHandlers.get('query:interrupt')!({}, undefined);
    await waitFor(() => sentOn('stream:error').length > 0);

    expect(sentOn('stream:error')).toHaveLength(1);
    expect(sentOn('stream:error')[0].code).toBe('INTERRUPTED');
    expect(sentOn('stream:turnDone')).toEqual([]);
  });
});
