/**
 * Coderix Desktop — Preload Script
 *
 * Exposes a safe, typed API to the renderer process via contextBridge.
 * All IPC communication is channeled through ipcRenderer.invoke / ipcRenderer.on.
 *
 * Security: contextIsolation=true, nodeIntegration=false.
 * The renderer NEVER has direct access to Node.js or Electron APIs.
 */

import { contextBridge, ipcRenderer } from 'electron';

// ---------------------------------------------------------------------------
// Channel name constants — MUST stay in sync with ipc-bridge.ts
// ---------------------------------------------------------------------------

const CH = {
  // Request / Response (ipcRenderer.invoke)
  QUERY_SUBMIT: 'query:submit',
  QUERY_INTERRUPT: 'query:interrupt',
  SESSION_LIST: 'session:list',
  SESSION_LOAD: 'session:load',
  SESSION_FORK: 'session:fork',
  SESSION_DELETE: 'session:delete',
  PERMISSION_APPROVE: 'permission:approve',
  PERMISSION_DENY: 'permission:deny',
  PERMISSION_SET_MODE: 'permission:setMode',
  FS_READ_FILE: 'fs:readFile',
  FS_WRITE_FILE: 'fs:writeFile',
  FS_LIST_DIR: 'fs:listDir',
  FS_WATCH: 'fs:watch',
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DESTROY: 'terminal:destroy',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_MODEL_LIST: 'config:getModelList',
  APP_VERSION: 'app:version',
  APP_CHECK_UPDATE: 'app:checkUpdate',
  APP_QUIT: 'app:quit',

  // Push channels (main → renderer via ipcRenderer.on)
  STREAM_BLOCK_START: 'stream:blockStart',
  STREAM_BLOCK_DELTA: 'stream:blockDelta',
  STREAM_BLOCK_STOP: 'stream:blockStop',
  STREAM_TOOL_STATE: 'stream:toolState',
  STREAM_TOOL_RESULT: 'stream:toolResult',
  STREAM_DONE: 'stream:done',
  STREAM_ERROR: 'stream:error',
  STATE_PERMISSION_REQ: 'state:permissionReq',
  STATE_QUESTION_REQ: 'state:questionReq',
  STATE_TOKEN_USAGE: 'state:tokenUsage',
  STATE_COST_UPDATE: 'state:costUpdate',
  STATE_COMPACT: 'state:compact',
  FS_FILE_CHANGED: 'fs:fileChanged',
  WINDOW_FOCUS: 'window:focus',
  APP_UPDATE_AVAILABLE: 'app:updateAvailable',
} as const;

// ---------------------------------------------------------------------------
// Stream event types (for onStreamEvent callback)
// ---------------------------------------------------------------------------

interface StreamBlockStart {
  type: 'blockStart';
  index: number;
  content_block: unknown;
}

interface StreamBlockDelta {
  type: 'blockDelta';
  index: number;
  delta: unknown;
}

interface StreamBlockStop {
  type: 'blockStop';
  index: number;
}

interface StreamToolState {
  type: 'toolState';
  toolUseId: string;
  toolName: string;
  state: string;
}

interface StreamToolResult {
  type: 'toolResult';
  toolUseId: string;
  result: unknown;
}

interface StreamDone {
  type: 'done';
  stopReason: string;
  usage?: unknown;
  model?: string;
}

interface StreamError {
  type: 'error';
  message: string;
  code: string;
}

type StreamEventData =
  | StreamBlockStart
  | StreamBlockDelta
  | StreamBlockStop
  | StreamToolState
  | StreamToolResult
  | StreamDone
  | StreamError;

// ---------------------------------------------------------------------------
// Permission request type
// ---------------------------------------------------------------------------

interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  command: string;
  description: string;
}

// ---------------------------------------------------------------------------
// State change type
// ---------------------------------------------------------------------------

interface StateChange {
  type: 'tokenUsage' | 'costUpdate' | 'compact' | 'fileChanged' | 'focus' | 'updateAvailable';
  data: unknown;
}

// ---------------------------------------------------------------------------
// Helper: create an event listener with unsubscribe
// ---------------------------------------------------------------------------

function createEventListener(
  channels: readonly string[],
  callback: (event: StreamEventData) => void,
): () => void {
  const handlers: Array<{ channel: string; handler: (...args: unknown[]) => void }> = [];

  for (const channel of channels) {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      const data = args[0] as Record<string, unknown>;

      switch (channel) {
        case CH.STREAM_BLOCK_START:
          callback({
            type: 'blockStart',
            index: (data?.index as number) ?? 0,
            content_block: data?.content_block,
          });
          break;
        case CH.STREAM_BLOCK_DELTA:
          callback({
            type: 'blockDelta',
            index: (data?.index as number) ?? 0,
            delta: data?.delta,
          });
          break;
        case CH.STREAM_BLOCK_STOP:
          callback({
            type: 'blockStop',
            index: (data?.index as number) ?? 0,
          });
          break;
        case CH.STREAM_TOOL_STATE:
          callback({
            type: 'toolState',
            toolUseId: (data?.toolUseId as string) ?? '',
            toolName: (data?.toolName as string) ?? '',
            state: (data?.state as string) ?? '',
          });
          break;
        case CH.STREAM_TOOL_RESULT:
          callback({
            type: 'toolResult',
            toolUseId: (data?.toolUseId as string) ?? '',
            result: data?.result,
          });
          break;
        case CH.STREAM_DONE:
          callback({
            type: 'done',
            stopReason: (data?.stopReason as string) ?? 'end_turn',
            usage: data?.usage,
            model: (data?.model as string | undefined),
          });
          break;
        case CH.STREAM_ERROR:
          callback({
            type: 'error',
            message: (data?.message as string) ?? 'Unknown error',
            code: (data?.code as string) ?? 'UNKNOWN',
          });
          break;
      }
    };

    ipcRenderer.on(channel, handler as (...args: unknown[]) => void);
    handlers.push({ channel, handler: handler as (...args: unknown[]) => void });
  }

  // Return unsubscribe function
  return () => {
    for (const { channel, handler } of handlers) {
      ipcRenderer.removeListener(channel, handler);
    }
  };
}

// ---------------------------------------------------------------------------
// The exposed API
// ---------------------------------------------------------------------------

const coderixAPI = {
  // ── Query ────────────────────────────────────────────────────────────

  query: {
    /**
     * Submit a user query to the AI engine.
     * @param query - The user's input message
     * @param sessionId - Optional session ID to route the query to
     */
    submit(query: string, sessionId?: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.QUERY_SUBMIT, { query, sessionId });
    },

    /**
     * Interrupt the currently running query.
     */
    interrupt(): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.QUERY_INTERRUPT);
    },
  },

  // ── Session ──────────────────────────────────────────────────────────

  session: {
    /** Create a new session. */
    create(opts?: { title?: string }): Promise<{ id: string; title: string; turnCount: number }> {
      return ipcRenderer.invoke('session:create', opts ?? {});
    },

    /** List all sessions. */
    list(): Promise<unknown[]> {
      return ipcRenderer.invoke(CH.SESSION_LIST);
    },

    /** Load a session by ID and set it as active. */
    load(sessionId: string): Promise<unknown> {
      return ipcRenderer.invoke(CH.SESSION_LOAD, sessionId);
    },

    /** Fork a session from an existing one. */
    fork(sessionId: string): Promise<unknown> {
      return ipcRenderer.invoke(CH.SESSION_FORK, sessionId);
    },

    /** Delete a session by ID. */
    delete(sessionId: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.SESSION_DELETE, sessionId);
    },
  },

  // ── Permission ───────────────────────────────────────────────────────

  permission: {
    /** Approve a permission request. */
    approve(toolUseId: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.PERMISSION_APPROVE, toolUseId);
    },

    /** Deny a permission request. */
    deny(toolUseId: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.PERMISSION_DENY, toolUseId);
    },

    /** Set the global permission mode. */
    setMode(mode: 'auto' | 'ask' | 'plan'): Promise<{ mode: string }> {
      return ipcRenderer.invoke(CH.PERMISSION_SET_MODE, mode);
    },
  },

  // ── Question (AskUserQuestion) ─────────────────────────────────────

  question: {
    /** Answer a pending question from the engine. */
    answer(toolUseId: string, answers: Record<string, string | string[]>): Promise<{ status: string }> {
      return ipcRenderer.invoke('question:answer', { toolUseId, answers });
    },
  },

  // ── File System ──────────────────────────────────────────────────────

  fs: {
    /** Read a file's content. */
    readFile(filePath: string): Promise<{ content: string; path: string }> {
      return ipcRenderer.invoke(CH.FS_READ_FILE, filePath);
    },

    /** Write content to a file. */
    writeFile(path: string, content: string): Promise<{ status: string; path: string }> {
      return ipcRenderer.invoke(CH.FS_WRITE_FILE, { path, content });
    },

    /** List directory contents. */
    listDir(dirPath: string): Promise<{ path: string; entries: unknown[] }> {
      return ipcRenderer.invoke(CH.FS_LIST_DIR, dirPath);
    },

    /** Start watching a path for changes. Returns watcher ID. */
    watch(watchPath: string): Promise<{ watcherId: string; path: string }> {
      return ipcRenderer.invoke(CH.FS_WATCH, watchPath);
    },
  },

  // ── Terminal ─────────────────────────────────────────────────────────

  terminal: {
    /** Create a new terminal session. Returns terminal ID. */
    create(opts?: { cwd?: string; rows?: number; cols?: number }): Promise<{ terminalId: string }> {
      return ipcRenderer.invoke(CH.TERMINAL_CREATE, opts ?? {});
    },

    /** Write data to a terminal session. */
    write(sessionId: string, data: string): void {
      ipcRenderer.send(CH.TERMINAL_WRITE, { sessionId, data });
    },

    /** Resize a terminal session. */
    resize(sessionId: string, rows: number, cols: number): void {
      ipcRenderer.send(CH.TERMINAL_RESIZE, { sessionId, rows, cols });
    },

    /** Destroy a terminal session. */
    destroy(sessionId: string): void {
      ipcRenderer.send(CH.TERMINAL_DESTROY, { sessionId });
    },

    /**
     * Listen for terminal data events from a specific session.
     * Returns an unsubscribe function.
     */
    onData(sessionId: string, callback: (data: string) => void): () => void {
      const channel = `terminal:${sessionId}:data`;
      const handler = (_event: Electron.IpcRendererEvent, data: string) => {
        callback(data);
      };
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },

    /**
     * Listen for terminal exit events from a specific session.
     * Returns an unsubscribe function.
     */
    onExit(sessionId: string, callback: (exitCode: number) => void): () => void {
      const channel = `terminal:${sessionId}:exit`;
      const handler = (_event: Electron.IpcRendererEvent, exitCode: number) => {
        callback(exitCode);
      };
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  // ── Config ───────────────────────────────────────────────────────────

  config: {
    /** Get the current configuration. */
    get(): Promise<unknown> {
      return ipcRenderer.invoke(CH.CONFIG_GET);
    },

    /** Set a configuration value. */
    set(key: string, value: unknown): Promise<{ key: string; value: unknown; status: string }> {
      return ipcRenderer.invoke(CH.CONFIG_SET, { key, value });
    },

    /** Get the list of available AI models. */
    getModelList(): Promise<unknown[]> {
      return ipcRenderer.invoke(CH.CONFIG_GET_MODEL_LIST);
    },

    /** Hot-reload QueryEngine with updated config (after model/API key change). */
    reload(): Promise<{ status: string }> {
      return ipcRenderer.invoke('config:reload');
    },
  },

  // ── App ──────────────────────────────────────────────────────────────

  // ── Git ─────────────────────────────────────────────────────────────

  git: {
    /** Get git status: branch + changed files. */
    status(): Promise<{ branch: string; files: Array<{ file: string; type: string; code: string }> }> {
      return ipcRenderer.invoke('git:status');
    },
  },

  app: {
    /** Get the application version. */
    getVersion(): Promise<string> {
      return ipcRenderer.invoke(CH.APP_VERSION);
    },

    /** Check for available updates. */
    checkUpdate(): Promise<{ updateAvailable: boolean }> {
      return ipcRenderer.invoke(CH.APP_CHECK_UPDATE);
    },

    /** Quit the application. */
    quit(): void {
      ipcRenderer.send(CH.APP_QUIT);
    },
  },

  // ── Event Subscriptions ──────────────────────────────────────────────

  /**
   * Subscribe to all stream events.
   * Returns an unsubscribe function.
   *
   * Events emitted:
   *   - { type: 'blockStart', index, content_block }
   *   - { type: 'blockDelta', index, delta }
   *   - { type: 'blockStop', index }
   *   - { type: 'toolState', toolUseId, toolName, state }
   *   - { type: 'toolResult', toolUseId, result }
   *   - { type: 'done', stopReason, usage?, model? }
   *   - { type: 'error', message, code }
   */
  onStreamEvent(callback: (event: StreamEventData) => void): () => void {
    return createEventListener(
      [
        CH.STREAM_BLOCK_START,
        CH.STREAM_BLOCK_DELTA,
        CH.STREAM_BLOCK_STOP,
        CH.STREAM_TOOL_STATE,
        CH.STREAM_TOOL_RESULT,
        CH.STREAM_DONE,
        CH.STREAM_ERROR,
      ],
      callback,
    );
  },

  /**
   * Subscribe to permission requests.
   * Returns an unsubscribe function.
   */
  onPermissionRequest(callback: (req: PermissionRequest) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: PermissionRequest) => {
      callback(data);
    };
    ipcRenderer.on(CH.STATE_PERMISSION_REQ, handler);
    return () => ipcRenderer.removeListener(CH.STATE_PERMISSION_REQ, handler);
  },

  /**
   * Subscribe to app state changes.
   * Returns an unsubscribe function.
   *
   * Events emitted:
   *   - { type: 'tokenUsage', data: { inputTokens, outputTokens, ... } }
   *   - { type: 'costUpdate', data: { totalCost, currency } }
   *   - { type: 'compact', data: unknown }
   *   - { type: 'fileChanged', data: FileChangeEvent }
   *   - { type: 'focus', data: { focused: boolean } }
   *   - { type: 'updateAvailable', data: unknown }
   */
  onStateChange(callback: (change: StateChange) => void): () => void {
    const stateChannels = [
      { channel: CH.STATE_TOKEN_USAGE, type: 'tokenUsage' as const },
      { channel: CH.STATE_COST_UPDATE, type: 'costUpdate' as const },
      { channel: CH.STATE_COMPACT, type: 'compact' as const },
      { channel: CH.FS_FILE_CHANGED, type: 'fileChanged' as const },
      { channel: CH.WINDOW_FOCUS, type: 'focus' as const },
      { channel: CH.APP_UPDATE_AVAILABLE, type: 'updateAvailable' as const },
    ];

    const handlers: Array<{ channel: string; handler: (...args: unknown[]) => void }> = [];

    for (const { channel, type } of stateChannels) {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        callback({ type, data });
      };
      ipcRenderer.on(channel, handler as (...args: unknown[]) => void);
      handlers.push({ channel, handler: handler as (...args: unknown[]) => void });
    }

    return () => {
      for (const { channel, handler } of handlers) {
        ipcRenderer.removeListener(channel, handler);
      }
    };
  },

  /**
   * Subscribe to question requests from the engine.
   * Returns an unsubscribe function.
   */
  onQuestionRequest(
    callback: (req: { toolUseId: string; toolName: string; questions: Array<{ header: string; question: string; options?: Array<{ label: string; description: string }>; multiSelect?: boolean }> }) => void,
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { toolUseId: string; toolName: string; questions: Array<{ header: string; question: string; options?: Array<{ label: string; description: string }>; multiSelect?: boolean }> },
    ) => {
      callback(data);
    };
    ipcRenderer.on(CH.STATE_QUESTION_REQ, handler);
    return () => ipcRenderer.removeListener(CH.STATE_QUESTION_REQ, handler);
  },
};

// ---------------------------------------------------------------------------
// Expose to renderer
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('coderixAPI', coderixAPI);

// ---------------------------------------------------------------------------
// Type augmentation for the renderer
// ---------------------------------------------------------------------------

// This type is declared here for reference; the actual .d.ts should be in
// src/renderer/types/ or src/preload/types.ts
export type CoderixAPI = typeof coderixAPI;
