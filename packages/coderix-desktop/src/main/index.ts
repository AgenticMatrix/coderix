/**
 * Coderix Desktop — Electron Main Process Entry Point
 */

import { app, BrowserWindow } from 'electron';
import { createWindowManager } from './window-manager.js';
import type { WindowManager } from './window-manager.js';
import { createIpcBridge } from './ipc-bridge.js';
import type { IpcBridge } from './ipc-bridge.js';
import { createFileWatcherManager } from './file-watcher.js';
import type { FileWatcherManager } from './file-watcher.js';
import { createTerminalManager } from './native-terminal.js';
import type { TerminalManager } from './native-terminal.js';
import { createTrayManager } from './tray-manager.js';
import type { TrayManager } from './tray-manager.js';

import { QueryEngine, SessionManager, ToolRegistry, createCallModelFromClient, plugins, loadConfig } from '@coderix/core';
import type { QueryEngineConfig } from '@coderix/core';

// ---------------------------------------------------------------------------
// Prevent multiple instances (single-instance lock)
// ---------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let windowManager: WindowManager | null = null;
let ipcBridge: IpcBridge | null = null;
let fileWatcher: FileWatcherManager | null = null;
let terminalManager: TerminalManager | null = null;
let trayManager: TrayManager | null = null;

// ---------------------------------------------------------------------------
// Bootstrap sequence — create window FIRST before any heavy init
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  try {
    // Step 1: Create window manager
    windowManager = createWindowManager();

    // Step 2: Create IPC bridge BEFORE window (renderer calls IPC on load)
    fileWatcher = createFileWatcherManager();
    terminalManager = createTerminalManager();
    ipcBridge = createIpcBridge({
      windowManager,
      fileWatcher,
      terminalManager,
    });

    // Step 3: Create the window — this must happen before heavy init
    const mainWindow = windowManager.createMainWindow();
    if (!mainWindow) {
      throw new Error('Failed to create main window');
    }
    fileWatcher.setMainWindow(mainWindow);

    // Step 4: Set up system tray
    trayManager = createTrayManager();
    trayManager.create(() => windowManager?.getMainWindow() ?? null);

    // Step 5: Handle second-instance
    app.on('second-instance', () => {
      const win = windowManager?.getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });

    // Step 6: Handle open-file (macOS)
    app.on('open-file', (_event, filePath) => {
      const win = windowManager?.getMainWindow();
      if (win) {
        win.webContents.send('app:openFile', filePath);
      }
    });

    console.log('[Coderix] Bootstrap complete');

    // Step 7: Defer QueryEngine init to avoid blocking renderer startup
    setTimeout(() => {
      initQueryEngine().catch((err) => {
        console.error('[Coderix] Failed to initialize query engine:', err);
      });
    }, 1000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Coderix] Bootstrap failed:', message);
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// QueryEngine initialization
// ---------------------------------------------------------------------------

async function initQueryEngine(): Promise<void> {
  if (!ipcBridge) {
    throw new Error('IPC bridge not initialized');
  }

  // Load config from ~/.coderix/settings.json
  const appConfig = loadConfig();
  const model = appConfig.model;
  const apiKey = appConfig.apiKey;
  const baseURL = appConfig.baseUrl;

  console.log(`[Coderix] Config loaded: model=${model}, baseURL=${baseURL}`);

  let callModel: QueryEngineConfig['callModel'];
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey,
      baseURL,
    });
    callModel = createCallModelFromClient(client, model);
    console.log(`[Coderix] callModel initialized: model=${model}, baseURL=${baseURL}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Coderix] Failed to initialize Anthropic client:', message);
    callModel = (async function* (_params: unknown) {
      yield {
        type: 'message' as const,
        data: {
          type: 'assistant' as const,
          message: {
            content: `⚠️ **API 未配置**\n\n无法初始化模型客户端:\n\`\`\`\n${message}\n\`\`\`\n\n请在设置中配置 API Key。`,
            stop_reason: 'end_turn' as const,
            usage: { input_tokens: 0, output_tokens: 0 },
            model: 'system',
          },
        },
      } as unknown;
    }) as unknown as QueryEngineConfig['callModel'];
  }

  // Register all built-in tool plugins
  const toolRegistry = new ToolRegistry();
  for (const plugin of plugins) {
    if (!plugin.isEnabled || plugin.isEnabled()) {
      toolRegistry.register(
        {
          name: plugin.name,
          description: plugin.schema.description ?? '',
          input_schema: plugin.schema.input_schema ?? { type: 'object', properties: {} },
        },
        async (input, ctx) => {
          const result = await plugin.executor(input, {
            cwd: ctx.cwd ?? process.cwd(),
            allowMutation: true,
            maxOutput: 50_000,
            signal: ctx.signal,
            agentSpawn: (ctx as any).agentSpawn,
            setPermissionMode: (ctx as any).setPermissionMode,
            sessionId: (ctx as any).sessionId,
          } as any);
          return result as any;
        },
      );
    }
  }
  console.log(`[Coderix] Registered ${toolRegistry.names.length} tools: ${toolRegistry.names.join(', ')}`);

  const config: QueryEngineConfig = {
    cwd: process.cwd(),
    model,
    customSystemPrompt: undefined,
    sessionManager: new SessionManager(),
    toolRegistry,
    callModel,
  };

  await ipcBridge.initEngine(config);
  console.log('[Coderix] QueryEngine initialized');
}

// ---------------------------------------------------------------------------
// App lifecycle events
// ---------------------------------------------------------------------------

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (windowManager) {
    const existingWindow = windowManager.getMainWindow();
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.show();
      existingWindow.focus();
    } else {
      windowManager.createMainWindow();
    }
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

app.on('before-quit', () => {
  console.log('[Coderix] Shutting down...');
  windowManager?.saveWindowState();
  ipcBridge?.destroy();
  fileWatcher?.destroy();
  terminalManager?.destroyAll();
  trayManager?.destroy();
  console.log('[Coderix] Shutdown complete');
});

// ---------------------------------------------------------------------------
// Unhandled error handling
// ---------------------------------------------------------------------------

process.on('uncaughtException', (error) => {
  console.error('[Coderix] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Coderix] Unhandled rejection:', reason);
});
