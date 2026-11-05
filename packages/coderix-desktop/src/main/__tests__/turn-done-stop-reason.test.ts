/**
 * The turn's stop reason must survive the whole trip: engine -> bridge
 * `stream:turnDone` -> renderer. The summary line under the final message is
 * only as honest as this payload, so a dropped reason silently degrades it to
 * "completed normally".
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
    getPath: () => '/tmp/coderix-stop-reason-test',
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

function stageStream(steps: any[]): (opts: any) => AsyncGenerator<any> {
  return () =>
    (async function* () {
      for (const step of steps) yield step;
    })() as AsyncGenerator<any>;
}

/** An assistant message with a real stop_reason, as the SDK emits per step. */
function assistantStep(stopReason: string, content: any[] = [{ type: 'text', text: 'ok' }]) {
  return {
    type: 'message',
    data: {
      type: 'assistant',
      message: { role: 'assistant', content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 } },
    },
  };
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

describe('stream:turnDone carries the stop reason', () => {
  it('reports the ending of the last model step', async () => {
    // A real turn: a tool step, then the final answer. The verdict must be the
    // LAST reason (`end_turn`), not the intermediate `tool_use`.
    engineFactory.current = stageStream([
      assistantStep('tool_use', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      { type: 'message', data: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } } },
      assistantStep('end_turn'),
      { type: 'done', data: { result: 'ok', stopReason: 'end_turn' } },
    ]);

    await ipcHandlers.get('query:submit')!({}, { query: 'hi' });
    await waitFor(() => sentOn('stream:turnDone').length > 0);

    expect(sentOn('stream:turnDone')[0].stopReason).toBe('end_turn');
  });

  it('reports a turn cut off at the output limit', async () => {
    engineFactory.current = stageStream([
      assistantStep('max_tokens'),
      { type: 'done', data: { result: 'half', stopReason: 'max_tokens' } },
    ]);

    await ipcHandlers.get('query:submit')!({}, { query: 'hi' });
    await waitFor(() => sentOn('stream:turnDone').length > 0);

    expect(sentOn('stream:turnDone')[0].stopReason).toBe('max_tokens');
  });

  it('leaves the reason unset when the engine never reports one', async () => {
    engineFactory.current = stageStream([
      { type: 'done', data: { result: 'ok' } },
    ]);

    await ipcHandlers.get('query:submit')!({}, { query: 'hi' });
    await waitFor(() => sentOn('stream:turnDone').length > 0);

    // The renderer must be able to tell "no ending recorded" from "completed".
    expect(sentOn('stream:turnDone')[0].stopReason).toBeUndefined();
  });
});