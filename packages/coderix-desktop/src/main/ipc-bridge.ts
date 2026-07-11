/**
 * IPC Bridge — Main ↔ Renderer communication layer
 *
 * Implements all IPC channel handlers per ADR-001 §2.5.
 * Bridges the Coderix core engine (QueryEngine) with the Electron renderer.
 *
 * Architecture:
 *   Renderer (React)  ←→  Preload (contextBridge)  ←→  ipcMain (this file)  ←→  QueryEngine
 *                                ipcRenderer                        ipcMain.handle/on
 */

import { ipcMain, BrowserWindow, app, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';

import type {
  Session,
  SessionSummary,
  StreamEvent,
  DeferredPermission,
  DeferredQuestion,
  CompletionUsage,
} from '@coderix/core';
import type { CoderSettings, ModelItem } from '@coderix/core';
import { QueryEngine, SessionManager, ToolRegistry, PermissionMode } from '@coderix/core';
import type { QueryEngineConfig, QueryEngineEvent } from '@coderix/core';
import { loadSettings } from '@coderix/core';

import type { WindowManager } from './window-manager.js';
import type { FileWatcherManager } from './file-watcher.js';
import type { TerminalManager } from './native-terminal.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IpcBridgeConfig {
  windowManager: WindowManager;
  fileWatcher: FileWatcherManager;
  terminalManager: TerminalManager;
  reloadQueryEngine?: () => Promise<void>;
}

export interface IpcBridge {
  queryEngine: QueryEngine | null;
  initEngine(config: QueryEngineConfig): Promise<void>;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Channel name constants — keep in sync with preload/index.ts
// ---------------------------------------------------------------------------

export const IPC_CHANNELS = {
  // Request / Response
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

  // Push (main → renderer)
  STREAM_BLOCK: 'stream:block',       // combined block event (for preload compatibility)
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
// Helper: get the main BrowserWindow
// ---------------------------------------------------------------------------

function getMainWindow(windowManager: WindowManager): BrowserWindow | null {
  return windowManager.getMainWindow() ?? null;
}

// ---------------------------------------------------------------------------
// registerIpcHandlers
// ---------------------------------------------------------------------------

export function createIpcBridge(config: IpcBridgeConfig): IpcBridge {
  const { windowManager, fileWatcher, terminalManager } = config;

  // Internal state
  let queryEngine: QueryEngine | null = null;
  let sessionManager: SessionManager | null = null;
  let toolRegistry: ToolRegistry | null = null;
  let activeAbortController: AbortController | null = null;
  let pendingPermission: DeferredPermission | null = null;
  let pendingQuestion: DeferredQuestion | null = null;
  let permissionsState: {
    resolve: ((value: boolean) => void) | null;
    reject: ((reason: Error) => void) | null;
  } = { resolve: null, reject: null };
  let questionsState: {
    resolve: ((value: Record<string, string | string[]>) => void) | null;
    reject: ((reason: Error) => void) | null;
  } = { resolve: null, reject: null };

  // -----------------------------------------------------------------------
  // Request / Response channels
  // -----------------------------------------------------------------------

  // ── Query ──────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.QUERY_SUBMIT, async (_event, payload: { query: string; sessionId?: string }) => {
    if (!queryEngine || !sessionManager) {
      throw new Error('QueryEngine not initialized');
    }

    const { query: userInput, sessionId } = payload;

    // Ensure we have an active session (create one if needed)
    try {
      sessionManager.getActive();
    } catch {
      sessionManager.create({ title: '新对话' });
    }

    // Switch to requested session if it exists
    if (sessionId) {
      try {
        if (sessionManager.getActive()?.id !== sessionId) {
          sessionManager.resume(sessionId);
        }
      } catch {
        // Session doesn't exist — keep using the current (newly created) one
        console.warn(`[IpcBridge] Session not found: ${sessionId}, using current session`);
      }
    }

    // Abort any existing query
    if (activeAbortController) {
      activeAbortController.abort();
      await new Promise(r => setTimeout(r, 0));
    }
    activeAbortController = new AbortController();

    const mainWindow = getMainWindow(windowManager);
    if (!mainWindow) throw new Error('No main window');

    // Update session title to first question (if still default)
    try {
      const active = sessionManager.getActive();
      if (active && (active.title === '新对话' || active.title.startsWith('Session '))) {
        const title = userInput.length > 30 ? userInput.slice(0, 30) + '...' : userInput;
        active.title = title;
        const sessionDir = join(homedir(), '.coderix', 'sessions', active.id);
        if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
        writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(active, null, 2), 'utf-8');
      }
    } catch { /* ignore */ }

    // Start streaming in background (don't await — send via push channels)
    (async () => {
      try {
        for await (const event of queryEngine!.submitMessage(userInput)) {
          if (activeAbortController?.signal.aborted) break;

          switch (event.type) {
            case 'message': {
              const msg = event.data as {
                type: string;
                event?: StreamEvent;
                message?: { content: unknown; stop_reason?: string; usage?: CompletionUsage; model?: string };
              };
              if (msg.type === 'stream_event' && msg.event) {
                forwardStreamEvent(mainWindow, msg.event);
              } else if (msg.type === 'assistant' && msg.message) {
                mainWindow.webContents.send(IPC_CHANNELS.STREAM_DONE, {
                  stopReason: msg.message.stop_reason ?? 'end_turn',
                  usage: msg.message.usage,
                  model: msg.message.model,
                });
              }
              break;
            }
            case 'permission_required': {
              const deferred = event.deferred as DeferredPermission;
              pendingPermission = deferred;
              mainWindow.webContents.send(IPC_CHANNELS.STATE_PERMISSION_REQ, {
                toolUseId: deferred.toolUseId,
                toolName: deferred.toolName,
                command: deferred.command,
                description: deferred.description,
              });
              // Wait for user response (via permission:approve or permission:deny IPC)
              break;
            }
            case 'question_required': {
              const deferred = event.deferred as DeferredQuestion;
              pendingQuestion = deferred;
              mainWindow.webContents.send(IPC_CHANNELS.STATE_QUESTION_REQ, {
                toolUseId: deferred.toolUseId,
                toolName: deferred.toolName,
                questions: deferred.questions,
              });
              // Wait for user response (via a question:answer channel or similar)
              break;
            }
            case 'error': {
              const err = event.data as { message?: string; code?: string };
              mainWindow.webContents.send(IPC_CHANNELS.STREAM_ERROR, {
                message: sanitizeErrorMessage(err?.message ?? 'Unknown error'),
                code: err?.code ?? 'UNKNOWN',
              });
              break;
            }
            case 'cost': {
              const costData = event.data as { totalCost?: number; currency?: string };
              mainWindow.webContents.send(IPC_CHANNELS.STATE_COST_UPDATE, costData);
              break;
            }
            case 'compact': {
              mainWindow.webContents.send(IPC_CHANNELS.STATE_COMPACT, event.data);
              break;
            }
            case 'done': {
              // Query complete
              break;
            }
          }
        }
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message = sanitizeErrorMessage(rawMessage);
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_ERROR, { message, code: 'RUNTIME' });
      } finally {
        if (activeAbortController?.signal.aborted) {
          const mw = getMainWindow(windowManager);
          mw?.webContents.send(IPC_CHANNELS.STREAM_ERROR, {
            message: 'Query interrupted by user',
            code: 'INTERRUPTED',
          });
        }
      }
    })();

    return { status: 'submitted' };
  });

  ipcMain.handle(IPC_CHANNELS.QUERY_INTERRUPT, async () => {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    return { status: 'interrupted' };
  });

  // ── Session ────────────────────────────────────────────────────────────

  ipcMain.handle('session:create', async (_event, opts?: { title?: string }) => {
    if (!sessionManager) throw new Error('SessionManager not initialized');
    const session = sessionManager.create({ title: opts?.title ?? '新对话' });
    return { id: session.id, title: session.title, turnCount: session.turnCount };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    if (sessionManager) return sessionManager.listSessions();
    // Disk fallback before QueryEngine is ready
    try {
      const sessionsDir = join(homedir(), '.coderix', 'sessions');
      if (!existsSync(sessionsDir)) return [];
      return readdirSync(sessionsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
          const f = join(sessionsDir, e.name, 'session.json');
          if (!existsSync(f)) return null;
          try {
            const d = JSON.parse(readFileSync(f, 'utf-8'));
            return { id: d.id, title: d.title, turnCount: d.turnCount || 0, model: d.model || '', updatedAt: new Date(d.updatedAt).getTime(), createdAt: new Date(d.createdAt).getTime() };
          } catch { return null; }
        })
        .filter(Boolean);
    } catch { return []; }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_event, sessionId: string) => {
    if (!sessionManager) throw new Error('SessionManager not initialized');
    const session = sessionManager.resume(sessionId);
    return { id: session.id, title: session.title, messages: session.messages, turnCount: session.turnCount };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_FORK, async (_event, sessionId: string) => {
    if (!sessionManager) throw new Error('SessionManager not initialized');
    const forked = sessionManager.fork({ sessionId });
    return { id: forked.id, title: forked.title, turnCount: forked.turnCount };
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId: string) => {
    if (!sessionManager) throw new Error('SessionManager not initialized');
    sessionManager.delete(sessionId);
    return { status: 'deleted' };
  });

  // ── Permission ─────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PERMISSION_APPROVE, async (_event, toolUseId: string) => {
    if (pendingPermission && pendingPermission.toolUseId === toolUseId) {
      pendingPermission.resolve(true);
      pendingPermission = null;
    }
    return { status: 'approved' };
  });

  ipcMain.handle(IPC_CHANNELS.PERMISSION_DENY, async (_event, toolUseId: string) => {
    if (pendingPermission && pendingPermission.toolUseId === toolUseId) {
      pendingPermission.resolve(false);
      pendingPermission = null;
    }
    return { status: 'denied' };
  });

  // ── Question (AskUserQuestion) ──────────────────────────────────────

  ipcMain.handle('question:answer', async (_event, payload: { toolUseId: string; answers: Record<string, string | string[]> }) => {
    if (pendingQuestion && pendingQuestion.toolUseId === payload.toolUseId) {
      pendingQuestion.resolve(payload.answers);
      pendingQuestion = null;
    }
    return { status: 'answered' };
  });

  ipcMain.handle(IPC_CHANNELS.PERMISSION_SET_MODE, async (_event, mode: string) => {
    // Mode can be 'plan' | 'ask' | 'auto'
    if (mode === 'plan' || mode === 'ask' || mode === 'auto') {
      if (queryEngine) {
        queryEngine.setPermissionMode(mode as PermissionMode);
      }
    }
    return { mode };
  });

  // ── File System ────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.FS_READ_FILE, async (_event, filePath: string) => {
    const sanitized = sanitizePath(filePath);
    const content = await readFile(sanitized, 'utf-8');
    return { content, path: filePath };
  });

  ipcMain.handle(IPC_CHANNELS.FS_WRITE_FILE, async (_event, payload: { path: string; content: string }) => {
    const sanitized = sanitizePath(payload.path);
    await writeFile(sanitized, payload.content, 'utf-8');
    return { status: 'written', path: payload.path };
  });

  ipcMain.handle(IPC_CHANNELS.FS_LIST_DIR, async (_event, dirPath: string) => {
    const sanitized = sanitizePath(dirPath);
    const entries = await readdir(sanitized, { withFileTypes: true });
    const result = await Promise.all(
      entries.map(async (entry) => {
        let fileStats: Stats | null = null;
        try {
          fileStats = await stat(join(sanitized, entry.name));
        } catch { /* ignore */ }
        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
          size: fileStats?.size ?? 0,
          modifiedAt: fileStats?.mtime.toISOString() ?? null,
        };
      }),
    );
    return { path: dirPath, entries: result };
  });

  ipcMain.handle(IPC_CHANNELS.FS_WATCH, async (_event, watchPath: string) => {
    const sanitized = sanitizePath(watchPath);
    const watcherId = fileWatcher.watch(sanitized);
    return { watcherId, path: watchPath };
  });

  // ── Terminal ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, async (_event, opts: { cwd?: string; rows?: number; cols?: number }) => {
    const terminalId = randomUUID();
    const mainWindow = getMainWindow(windowManager);
    if (!mainWindow) throw new Error('No main window');

    terminalManager.create(terminalId, {
      cwd: opts.cwd ?? process.cwd(),
      rows: opts.rows ?? 30,
      cols: opts.cols ?? 120,
      onData: (data: string) => {
        mainWindow.webContents.send(`terminal:${terminalId}:data`, data);
      },
      onExit: (exitCode: number) => {
        mainWindow.webContents.send(`terminal:${terminalId}:exit`, exitCode);
      },
    });

    return { terminalId };
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_WRITE, (_event, payload: { sessionId: string; data: string }) => {
    terminalManager.write(payload.sessionId, payload.data);
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (_event, payload: { sessionId: string; rows: number; cols: number }) => {
    terminalManager.resize(payload.sessionId, payload.rows, payload.cols);
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_DESTROY, (_event, payload: { sessionId: string }) => {
    terminalManager.destroy(payload.sessionId);
  });

  // ── Git ────────────────────────────────────────────────────────────────

  ipcMain.handle('git:status', async () => {
    const { execSync } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    let cwd: string;
    try { cwd = findGitRoot(); } catch { return { branch: '', files: [], commits: [] }; }
    const inRepo = existsSync(require('node:path').join(cwd, '.git'));

    if (!inRepo) {
      console.log('[Coderix] git:status — no git repo found from', process.cwd());
      return { branch: '', files: [], commits: [] };
    }

    try {
      const branch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();
      const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' });
      const log = execSync('git log --all --oneline --graph --decorate -50', { cwd, encoding: 'utf-8' });

      const files = status.split('\n').filter(Boolean).map((line) => {
        const code = line.slice(0, 2).trim();
        const file = line.slice(3);
        let type: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' = 'modified';
        if (code.includes('?')) type = 'untracked';
        else if (code.includes('A')) type = 'added';
        else if (code.includes('D')) type = 'deleted';
        else if (code.includes('R')) type = 'renamed';
        return { file, type, code };
      });

      const commits = log.split('\n').filter(Boolean).map((line) => {
        const match = line.match(/^([*|/\\_\s]+)([0-9a-f]{7,})\s+(.*)$/);
        if (match) {
          const graph = match[1];
          const hash = match[2];
          const rest = match[3];
          const refMatch = rest.match(/\((.+?)\)$/);
          return {
            hash,
            message: refMatch ? rest.slice(0, rest.lastIndexOf('(')).trim() : rest.trim(),
            graph,
            refs: refMatch ? refMatch[1] : '',
          };
        }
        const [hash, ...rest] = line.split(' ');
        return { hash, message: rest.join(' '), graph: '', refs: '' };
      });

      console.log(`[Coderix] git:status — branch=${branch}, files=${files.length}, commits=${commits.length}`);
      return { branch, files, commits };
    } catch (e) {
      console.error('[Coderix] git:status failed:', (e as Error).message);
      return { branch: '', files: [], commits: [] };
    }
  });

  ipcMain.handle('git:diff', async (_event, payload: { file: string; staged?: boolean }) => {
    try {
      const { execSync } = await import('node:child_process');
      const cwd = findGitRoot();
      const args = payload.staged ? ['diff', '--staged', '--', payload.file] : ['diff', '--', payload.file];
      const diff = execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
      return { diff };
    } catch (e) { return { diff: '', error: (e as Error).message }; }
  });

  ipcMain.handle('git:log', async (_event, payload?: { maxCount?: number }) => {
    try {
      const { execSync } = await import('node:child_process');
      const cwd = findGitRoot();
      const n = payload?.maxCount ?? 30;
      // --graph --all for branch visualization, --decorate for branch names
      const log = execSync(
        `git log --all --oneline --graph --decorate -${n}`,
        { cwd, encoding: 'utf-8' },
      );
      const lines = log.split('\n').filter(Boolean);
      const commits: Array<{ hash: string; message: string; graph: string; refs: string }> = [];
      for (const line of lines) {
        // Parse: graph chars | hash message (refs)
        const match = line.match(/^([*|/\\_\s]+)([0-9a-f]{7,})\s+(.*)$/);
        if (match) {
          const graph = match[1];
          const hash = match[2];
          const rest = match[3];
          // Extract refs from parentheses
          const refMatch = rest.match(/\((.+?)\)$/);
          commits.push({
            hash,
            message: refMatch ? rest.slice(0, rest.lastIndexOf('(')).trim() : rest.trim(),
            graph,
            refs: refMatch ? refMatch[1] : '',
          });
        }
      }
      return { commits };
    } catch { return { commits: [] as Array<{ hash: string; message: string; graph: string; refs: string }> }; }
  });

  ipcMain.handle('git:show', async (_event, payload: { hash: string }) => {
    try {
      const { execSync } = await import('node:child_process');
      const cwd = findGitRoot();
      const stat = execSync(`git show --stat --name-status ${payload.hash}`, { cwd, encoding: 'utf-8' });
      const show = execSync(`git show ${payload.hash}`, { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
      // Parse --name-status output for changed files
      const files: Array<{ file: string; type: string }> = [];
      const lines = stat.split('\n');
      for (const line of lines) {
        const match = line.match(/^([MADR]\d{0,3})\s+(.+)$/);
        if (match) files.push({ file: match[2], type: match[1].charAt(0) });
      }
      return { diff: show, files };
    } catch (e) { return { diff: '', files: [], error: (e as Error).message }; }
  });

  ipcMain.handle('git:stage', async (_event, payload: { file?: string; all?: boolean }) => {
    try {
      const { execSync } = await import('node:child_process');
      const cwd = findGitRoot();
      if (payload.all) execSync('git add -A', { cwd, encoding: 'utf-8' });
      else if (payload.file) execSync(`git add ${payload.file}`, { cwd, encoding: 'utf-8' });
      return { status: 'ok' };
    } catch (e) { return { status: 'error', error: (e as Error).message }; }
  });

  ipcMain.handle('git:unstage', async (_event, payload: { file?: string; all?: boolean }) => {
    try {
      const { execSync } = await import('node:child_process');
      const cwd = findGitRoot();
      if (payload.all) execSync('git reset HEAD', { cwd, encoding: 'utf-8' });
      else if (payload.file) execSync(`git reset HEAD ${payload.file}`, { cwd, encoding: 'utf-8' });
      return { status: 'ok' };
    } catch (e) { return { status: 'error', error: (e as Error).message }; }
  });

  ipcMain.handle('git:commit', async (_event, payload: { message: string }) => {
    try {
      const { execSync } = await import('node:child_process');
      const cwd = findGitRoot();
      const result = execSync(`git commit -m "${payload.message.replace(/"/g, '\\"')}"`, { cwd, encoding: 'utf-8' });
      return { status: 'ok', output: result.trim() };
    } catch (e) { return { status: 'error', error: (e as Error).message }; }
  });

  // ── Config ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    return loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, async (_event, payload: { key: string; value: unknown }) => {
    const settingsDir = join(homedir(), '.coderix');
    const settingsPath = join(settingsDir, 'settings.json');
    const current = loadSettings();

    if (!payload.key) {
      // Empty key → merge value at top level
      const merged = { ...current, ...(payload.value as Record<string, unknown>) };
      if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
    } else {
      (current as Record<string, unknown>)[payload.key] = payload.value;
      if (!existsSync(settingsDir)) mkdirSync(settingsDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(current, null, 2), 'utf-8');
    }
    return { status: 'saved' };
  });

  ipcMain.handle('config:reload', async () => {
    console.log('[Coderix] config:reload triggered');
    if (config.reloadQueryEngine) {
      await config.reloadQueryEngine();
      console.log('[Coderix] config:reload completed');
      return { status: 'reloaded' };
    }
    console.log('[Coderix] config:reload skipped — no callback');
    return { status: 'skipped', reason: 'no reload callback' };
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_MODEL_LIST, async () => {
    const settings = loadSettings();
    return settings.model_list ?? [];
  });

  // ── App ────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.APP_VERSION, async () => app.getVersion());

  ipcMain.handle(IPC_CHANNELS.APP_CHECK_UPDATE, async () => {
    // Placeholder — actual implementation uses electron-updater
    return { updateAvailable: false };
  });

  ipcMain.on(IPC_CHANNELS.APP_QUIT, () => {
    app.quit();
  });

  // -----------------------------------------------------------------------
  // Push channel registration helpers
  // -----------------------------------------------------------------------

  // Forward StreamEvent to the correct push channel
  function forwardStreamEvent(mainWindow: BrowserWindow, event: StreamEvent): void {
    switch (event.type) {
      case 'content_block_start':
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_BLOCK_START, {
          index: event.index,
          content_block: event.content_block,
        });
        break;
      case 'content_block_delta':
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_BLOCK_DELTA, {
          index: event.index,
          delta: event.delta,
        });
        break;
      case 'content_block_stop':
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_BLOCK_STOP, {
          index: event.index,
        });
        break;
      case 'message_start':
        // Message start — could be used to reset UI state
        break;
      case 'message_delta':
        // Message delta — forward as delta event
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_BLOCK_DELTA, {
          index: -1,
          delta: event.delta,
        });
        break;
      case 'message_stop':
        mainWindow.webContents.send(IPC_CHANNELS.STREAM_DONE, {
          stopReason: 'end_turn',
        });
        break;
      default:
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Token usage tracking
  // -----------------------------------------------------------------------

  let lastTokenUsage: CompletionUsage | null = null;

  ipcMain.on('__internal_token_usage', (_event, usage: CompletionUsage) => {
    lastTokenUsage = usage;
    const mw = getMainWindow(windowManager);
    if (mw) {
      mw.webContents.send(IPC_CHANNELS.STATE_TOKEN_USAGE, {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        totalCost: usage.totalCost ?? 0,
      });
    }
  });

  // -----------------------------------------------------------------------
  // Cleanup handler
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    get queryEngine() {
      return queryEngine;
    },

    async initEngine(config: QueryEngineConfig): Promise<void> {
      const isReload = queryEngine !== null;

      // Preserve existing session manager and tool registry on reload
      if (!isReload || !sessionManager) {
        sessionManager = config.sessionManager ?? new SessionManager();
      }
      if (!isReload || !toolRegistry) {
        toolRegistry = config.toolRegistry ?? new ToolRegistry();
      }

      // Instantiate QueryEngine
      queryEngine = new QueryEngine({
        ...config,
        sessionManager,
        toolRegistry,
      });

      await queryEngine.init();
      const engineId = Date.now();
      (queryEngine as any).__engineId = engineId;
      if (isReload) console.log('[Coderix] QueryEngine reloaded, id:', engineId);
    },

    destroy(): void {
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      ipcMain.removeHandler(IPC_CHANNELS.QUERY_SUBMIT);
      ipcMain.removeHandler(IPC_CHANNELS.QUERY_INTERRUPT);
      ipcMain.removeHandler(IPC_CHANNELS.SESSION_LIST);
      ipcMain.removeHandler(IPC_CHANNELS.SESSION_LOAD);
      ipcMain.removeHandler(IPC_CHANNELS.SESSION_FORK);
      ipcMain.removeHandler(IPC_CHANNELS.SESSION_DELETE);
      ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_APPROVE);
      ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_DENY);
      ipcMain.removeHandler(IPC_CHANNELS.PERMISSION_SET_MODE);
      ipcMain.removeHandler(IPC_CHANNELS.FS_READ_FILE);
      ipcMain.removeHandler(IPC_CHANNELS.FS_WRITE_FILE);
      ipcMain.removeHandler(IPC_CHANNELS.FS_LIST_DIR);
      ipcMain.removeHandler(IPC_CHANNELS.FS_WATCH);
      ipcMain.removeHandler(IPC_CHANNELS.TERMINAL_CREATE);
      ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);
      ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SET);
      ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET_MODEL_LIST);
      ipcMain.removeHandler(IPC_CHANNELS.APP_VERSION);
      ipcMain.removeHandler(IPC_CHANNELS.APP_CHECK_UPDATE);
    },
  };
}

// ---------------------------------------------------------------------------
// Git helper — find repo root
// ---------------------------------------------------------------------------

function findGitRoot(): string {
  let current = process.cwd();
  const { join, dirname } = require('node:path') as typeof import('node:path');
  while (!require('node:fs').existsSync(join(current, '.git')) && current !== dirname(current)) {
    current = dirname(current);
  }
  if (!require('node:fs').existsSync(join(current, '.git'))) {
    throw new Error('Not in a git repository');
  }
  return current;
}

// ---------------------------------------------------------------------------
// Error message sanitization — strip HTML, friendlier messages
// ---------------------------------------------------------------------------

function sanitizeErrorMessage(raw: string): string {
  // Strip HTML tags (some APIs return HTML error pages)
  const stripped = raw.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, '').trim();

  // Common API errors → user-friendly messages
  if (raw.includes('401') || raw.includes('Unauthorized'))
    return '❌ API Key 无效或未配置，请在设置中填入正确的 API Key。';
  if (raw.includes('403') || raw.includes('Forbidden'))
    return '❌ API 访问被拒绝（403），请检查 API Key 权限。';
  if (raw.includes('429') || raw.includes('Too Many Requests'))
    return '⏳ API 请求频率过高（429），请稍后重试。';
  if (raw.includes('ENOTFOUND') || raw.includes('ECONNREFUSED') || raw.includes('getaddrinfo'))
    return '🔌 无法连接到 API 服务器，请检查 Base URL 和网络连接。';
  if (raw.includes('timeout') || raw.includes('ETIMEDOUT'))
    return '⏰ API 请求超时，请检查网络或稍后重试。';

  // Truncate long raw messages
  if (stripped.length > 300) return stripped.slice(0, 300) + '...';
  return stripped || '未知错误，请检查 API 配置。';
}

// ---------------------------------------------------------------------------
// Path sanitization — prevent directory traversal attacks
// ---------------------------------------------------------------------------

function sanitizePath(userPath: string): string {
  const normalized = normalize(userPath);
  // Prevent escaping to parent directories via ../
  if (normalized.includes('..')) {
    throw new Error(`Path traversal not allowed: ${userPath}`);
  }
  return normalized;
}
