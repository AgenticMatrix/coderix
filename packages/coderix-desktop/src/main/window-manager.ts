/**
 * Window Manager — BrowserWindow lifecycle management
 *
 * ADR-001 §3.1: Single-window with split panes, macOS native controls,
 * window position/size persistence.
 *
 * Singleton pattern — one manager per app instance.
 */

import { BrowserWindow, app, screen } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { safeSend } from './safe-send.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.coderix');
const WINDOW_STATE_FILE = join(CONFIG_DIR, 'window-state.json');

const DEFAULT_WINDOW_OPTIONS = {
  width: 1200,
  height: 800,
  minWidth: 700,
  minHeight: 500,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
  displayBounds?: { width: number; height: number };
}

export interface WindowManager {
  /** Get the main BrowserWindow instance. */
  getMainWindow(): BrowserWindow | null;
  /** Create (or return existing) main window. */
  createMainWindow(): BrowserWindow;
  /** Destroy the main window. */
  destroyMainWindow(): void;
  /** Save current window position and size to disk. */
  saveWindowState(): void;
  /** Load persisted window state from disk. */
  loadWindowState(): WindowState;
  /** Register window event listeners. */
  registerWindowEvents(win: BrowserWindow): void;
  /** Load renderer content (dev server URL or built HTML file). */
  loadContent(win: BrowserWindow): void;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// createWindowManager
// ---------------------------------------------------------------------------

export function createWindowManager(): WindowManager {
  let mainWindow: BrowserWindow | null = null;

  return {
    getMainWindow(): BrowserWindow | null {
      return mainWindow;
    },

    createMainWindow(): BrowserWindow {
      // Return existing window if already created
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
        return mainWindow;
      }

      const state = this.loadWindowState();
      const isMac = process.platform === 'darwin';

      mainWindow = new BrowserWindow({
        width: state.width,
        height: state.height,
        minWidth: DEFAULT_WINDOW_OPTIONS.minWidth,
        minHeight: DEFAULT_WINDOW_OPTIONS.minHeight,
        title: 'Coderix',
        // ── Platform-specific window chrome ────────────────────────────
        // macOS: hidden titlebar with traffic lights; Linux/Windows: OS titlebar
        ...(isMac
          ? {
              titleBarStyle: 'hidden' as const,
              trafficLightPosition: { x: 6, y: 11 },
              vibrancy: 'under-window' as const,
              visualEffectState: 'active' as const,
              tabbingIdentifier: 'coderix-main',
            }
          : {
              // Keep native OS titlebar for Linux/Windows
              autoHideMenuBar: true,
            }),
        backgroundColor: '#FAF9F5',
        // ── Show only when ready ───────────────────────────────────────
        show: false,
        webPreferences: {
          preload: join(__dirname, '../preload/index.mjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          webviewTag: false,
        },
      });

      // Log preload path for debugging
      console.log('[Coderix] Preload path:', join(__dirname, '../preload/index.mjs'));

      // Restore position if saved
      if (state.x !== undefined && state.y !== undefined) {
        mainWindow.setBounds({
          x: state.x,
          y: state.y,
          width: state.width,
          height: state.height,
        });
      }

      if (state.isMaximized) {
        mainWindow.maximize();
      }

      // Forward renderer console to main process for debugging
      mainWindow.webContents.on('console-message', (_event, level, message) => {
        const prefix = level === 3 ? 'RENDERER ERR' : 'RENDERER';
        console.log(`[${prefix}] ${message}`);
      });

      // Register events
      this.registerWindowEvents(mainWindow);

      // Load content
      this.loadContent(mainWindow);

      return mainWindow;
    },

    destroyMainWindow(): void {
      if (mainWindow && !mainWindow.isDestroyed()) {
        this.saveWindowState();
        mainWindow.destroy();
      }
      mainWindow = null;
    },

    saveWindowState(): void {
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const bounds = mainWindow.getBounds();
      const isMaximized = mainWindow.isMaximized();

      const state: WindowState = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized,
        displayBounds: screen.getPrimaryDisplay().bounds,
      };

      ensureConfigDir();
      writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    },

    loadWindowState(): WindowState {
      try {
        ensureConfigDir();
        if (existsSync(WINDOW_STATE_FILE)) {
          const raw = readFileSync(WINDOW_STATE_FILE, 'utf-8');
          const saved = JSON.parse(raw) as Partial<WindowState>;

          // Validate against current display bounds
          const currentDisplay = screen.getPrimaryDisplay();
          const savedDisplay = saved.displayBounds;

          // If the display has changed (e.g., external monitor disconnected),
          // fall back to defaults
          if (
            savedDisplay &&
            (Math.abs(savedDisplay.width - currentDisplay.bounds.width) > 100 ||
              Math.abs(savedDisplay.height - currentDisplay.bounds.height) > 100)
          ) {
            return {
              width: DEFAULT_WINDOW_OPTIONS.width,
              height: DEFAULT_WINDOW_OPTIONS.height,
              isMaximized: false,
            };
          }

          return {
            width: saved.width ?? DEFAULT_WINDOW_OPTIONS.width,
            height: saved.height ?? DEFAULT_WINDOW_OPTIONS.height,
            isMaximized: saved.isMaximized ?? false,
            x: saved.x,
            y: saved.y,
            displayBounds: currentDisplay.bounds,
          };
        }
      } catch {
        // Corrupted state file — use defaults
      }

      return {
        width: DEFAULT_WINDOW_OPTIONS.width,
        height: DEFAULT_WINDOW_OPTIONS.height,
        isMaximized: false,
      };
    },

    registerWindowEvents(win: BrowserWindow): void {
      // Graceful show — avoid white flash
      win.on('ready-to-show', () => {
        win.show();
        win.focus();
      });

      // Save position on move/resize (debounced)
      let saveTimeout: ReturnType<typeof setTimeout> | null = null;
      const debouncedSave = (): void => {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => this.saveWindowState(), 500);
      };

      win.on('move', debouncedSave);
      win.on('resize', debouncedSave);
      win.on('maximize', debouncedSave);
      win.on('unmaximize', debouncedSave);

      // Save on close
      win.on('close', () => {
        if (saveTimeout) clearTimeout(saveTimeout);
        this.saveWindowState();
      });

      // Notify renderer on focus — use safeSend so a crashed/disposed renderer
      // (blank white window) doesn't throw "Render frame was disposed".
      win.on('focus', () => {
        safeSend(win, 'window:focus', { focused: true });
      });
      win.on('blur', () => {
        safeSend(win, 'window:focus', { focused: false });
      });

      // Recover from a renderer crash (the usual cause of a blank white
      // window) by reloading instead of leaving the user staring at nothing.
      // Throttle reloads so a deterministically-crashing renderer can't spin
      // in an endless crash → reload → crash loop.
      let lastCrashReloadAt = 0;
      win.webContents.on('render-process-gone', (_event, details) => {
        console.error(
          `[Coderix] Renderer process gone (reason=${details.reason}, exitCode=${details.exitCode})`,
        );
        const now = Date.now();
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        if (now - lastCrashReloadAt < 5000) return;
        lastCrashReloadAt = now;
        win.webContents.reload();
      });

      // Cleanup on close
      win.on('closed', () => {
        mainWindow = null;
      });
    },

    loadContent(win: BrowserWindow): void {
      const isDev = !app.isPackaged;
      const filePath = join(__dirname, '../renderer/index.html');
      console.log('[Coderix] loadContent: isDev=%s, hasDevUrl=%s, isPackaged=%s, filePath=%s',
        isDev, !!process.env['ELECTRON_RENDERER_URL'], app.isPackaged, filePath);
      if (isDev && process.env['ELECTRON_RENDERER_URL']) {
        const devUrl = process.env['ELECTRON_RENDERER_URL'];
        console.log('[Coderix] Loading dev URL:', devUrl);
        win.loadURL(devUrl).then(() => {
          console.log('[Coderix] loadURL succeeded');
        }).catch((err: Error) => {
          console.error('[Coderix] Failed to load dev server URL:', err.message);
          if (!win.isDestroyed()) {
            win.loadFile(filePath).catch((err2: Error) => {
              console.error('[Coderix] Failed to load fallback HTML:', err2.message);
            });
          }
        });
      } else {
        console.log('[Coderix] Loading file:', filePath);
        win.loadFile(filePath).then(() => {
          console.log('[Coderix] loadFile succeeded');
        }).catch((err: Error) => {
          console.error('[Coderix] Failed to load renderer HTML:', err.message);
        });
      }
    },
  };
}
