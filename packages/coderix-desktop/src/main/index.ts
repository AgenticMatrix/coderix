/**
 * Coderix Desktop — Electron Main Process Entry Point
 *
 * Wires together all main-process modules:
 *   WindowManager → BrowserWindow lifecycle
 *   IpcBridge      → IPC channel handlers + QueryEngine bridge
 *   FileWatcher    → chokidar-based file system monitoring
 *   TerminalManager → PTY terminal sessions
 *   TrayManager    → macOS system tray
 *
 * Architecture (ADR-001 §2):
 *   Main Process  ←→  Preload (contextBridge)  ←→  Renderer (React)
 *        │                    │                         │
 *   QueryEngine        ipcRenderer              coderixAPI.*
 *   ToolRegistry       contextBridge
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

import { QueryEngine, SessionManager, ToolRegistry } from '@coderix/core';
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
// Bootstrap sequence
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  try {
    // ── Step 1: Create window manager ──────────────────────────────────
    windowManager = createWindowManager();

    // ── Step 2: Create main window ─────────────────────────────────────
    const mainWindow = windowManager.createMainWindow();
    if (!mainWindow) {
      throw new Error('Failed to create main window');
    }

    // ── Step 3: Create infrastructure managers ─────────────────────────
    fileWatcher = createFileWatcherManager();
    terminalManager = createTerminalManager();

    // Register main window with file watcher so it can push events
    fileWatcher.setMainWindow(mainWindow);

    // ── Step 4: Create IPC bridge ──────────────────────────────────────
    ipcBridge = createIpcBridge({
      windowManager,
      fileWatcher,
      terminalManager,
    });

    // ── Step 5: Initialize QueryEngine (non-blocking) ──────────────────
    initQueryEngine().catch((err) => {
      console.error('[Coderix] Failed to initialize query engine:', err);
    });

    // ── Step 6: Set up system tray ─────────────────────────────────────
    trayManager = createTrayManager();
    trayManager.create(() => windowManager?.getMainWindow() ?? null);

    // ── Step 7: Handle second-instance (focus existing window) ─────────
    app.on('second-instance', () => {
      const win = windowManager?.getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });

    // ── Step 8: Handle open-file / open-url (macOS) ────────────────────
    app.on('open-file', (_event, filePath) => {
      const win = windowManager?.getMainWindow();
      if (win) {
        win.webContents.send('app:openFile', filePath);
      }
    });

    console.log('[Coderix] Bootstrap complete');
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

  const config: QueryEngineConfig = {
    // The actual provider config will be loaded from user settings;
    // for now we use environment-based or default settings.
    cwd: process.cwd(),
    model: process.env['CODERIX_MODEL'] ?? 'deepseek-v4-pro',
    // System prompt can be customized via config
    customSystemPrompt: undefined,
    // Session manager and tool registry are created inside initEngine
    sessionManager: new SessionManager(),
    toolRegistry: new ToolRegistry(),
    // callModel stub — throws a clear error until real provider is configured
    callModel: (async (_params: unknown) => {
      throw new Error('Model client not initialized. Please configure an API key in Settings.');
    }) as unknown as QueryEngineConfig['callModel'],
  };

  await ipcBridge.initEngine(config);
  console.log('[Coderix] QueryEngine initialized');
}

// ---------------------------------------------------------------------------
// App lifecycle events
// ---------------------------------------------------------------------------

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  // On macOS, keep the app running in the menu bar (Dock)
  // The user can click the Dock icon or use Cmd+Tab to bring it back.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // macOS: re-create window when Dock icon is clicked and no windows are open
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

  // Save window state
  windowManager?.saveWindowState();

  // Destroy IPC bridge (removes handlers, aborts active queries)
  ipcBridge?.destroy();

  // Destroy all file watchers
  fileWatcher?.destroy();

  // Destroy all terminal sessions
  terminalManager?.destroyAll();

  // Destroy tray
  trayManager?.destroy();

  console.log('[Coderix] Shutdown complete');
});

// ---------------------------------------------------------------------------
// Unhandled error handling
// ---------------------------------------------------------------------------

process.on('uncaughtException', (error) => {
  console.error('[Coderix] Uncaught exception:', error);
  // Don't crash — log and attempt recovery
});

process.on('unhandledRejection', (reason) => {
  console.error('[Coderix] Unhandled rejection:', reason);
});
