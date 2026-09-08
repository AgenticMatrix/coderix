/**
 * Tray Manager — macOS system tray with context menu
 *
 * ADR-001 §3.4: System tray with Show/Hide, New Session,
 * Permission Mode toggle, Check for Updates, and Quit.
 */

import { Tray, Menu, app, BrowserWindow, nativeImage } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { safeSend } from './safe-send.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrayManager {
  /** Create the system tray (macOS menu bar icon). */
  create(getMainWindow: () => BrowserWindow | null): Tray | null;
  /** Destroy the tray. */
  destroy(): void;
  /** Update permission mode in tray context menu. */
  updatePermissionMode(mode: 'auto' | 'ask' | 'plan'): void;
}

// ---------------------------------------------------------------------------
// createTrayManager
// ---------------------------------------------------------------------------

export function createTrayManager(): TrayManager {
  let tray: Tray | null = null;

  return {
    create(getMainWindow: () => BrowserWindow | null): Tray | null {
      // Tray is optional — skip if platform doesn't support it well
      if (process.platform === 'linux') {
        // Linux tray support is inconsistent; skip for now
        return null;
      }

      // ── Tray Icon ──────────────────────────────────────────────────
      const iconPath = resolveTrayIcon();
      let trayImage: Electron.NativeImage;

      if (iconPath && existsSync(iconPath)) {
        trayImage = nativeImage.createFromPath(iconPath);
      } else {
        // Fallback: create a simple 16x16 icon programmatically
        trayImage = nativeImage.createEmpty();
      }

      // Resize for macOS menu bar (22x22 for Retina)
      const resized = trayImage.resize({ width: 22, height: 22 });
      // macOS template image: auto-adapts to dark/light menu bar
      if (process.platform === 'darwin') {
        resized.setTemplateImage(true);
      }

      tray = new Tray(resized);
      tray.setToolTip('Coderix');

      this.updatePermissionMode('ask');

      return tray;
    },

    destroy(): void {
      if (tray) {
        tray.destroy();
        tray = null;
      }
    },

    updatePermissionMode(mode: 'auto' | 'ask' | 'plan'): void {
      if (!tray) return;

      const mainWindow = (this as unknown as { _getMainWindow?: () => BrowserWindow | null })._getMainWindow;
      // Use a getter — we need to rebuild the menu

      const contextMenu = Menu.buildFromTemplate([
        {
          label: 'Show Coderix',
          click: () => {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) {
              win.show();
              win.focus();
            }
          },
        },
        {
          label: 'New Session',
          click: () => {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) {
              safeSend(win, 'state:newSession');
              win.show();
              win.focus();
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Permission Mode',
          submenu: [
            {
              label: 'Auto',
              type: 'radio',
              checked: mode === 'auto',
              click: () => {
                safeSend(BrowserWindow.getAllWindows()[0], 'permission:setMode', 'auto');
              },
            },
            {
              label: 'Ask',
              type: 'radio',
              checked: mode === 'ask',
              click: () => {
                safeSend(BrowserWindow.getAllWindows()[0], 'permission:setMode', 'ask');
              },
            },
            {
              label: 'Plan',
              type: 'radio',
              checked: mode === 'plan',
              click: () => {
                safeSend(BrowserWindow.getAllWindows()[0], 'permission:setMode', 'plan');
              },
            },
          ],
        },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => {
            app.emit('check-for-updates');
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          },
        },
      ]);

      tray.setContextMenu(contextMenu);
    },
  } as TrayManager;
}

// ---------------------------------------------------------------------------
// Icon resolution
// ---------------------------------------------------------------------------

function resolveTrayIcon(): string | null {
  const candidates = [
    // Production (packaged app)
    join(__dirname, '../assets/tray-icon.png'),
    join(__dirname, '../assets/tray-iconTemplate.png'),
    join(__dirname, '../assets/tray-iconTemplate@2x.png'),
    // Development (project root)
    join(app.getAppPath(), 'assets/tray-icon.png'),
    join(app.getAppPath(), 'assets/tray-iconTemplate.png'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
