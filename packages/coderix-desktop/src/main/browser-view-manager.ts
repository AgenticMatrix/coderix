/**
 * Browser View Manager — embeds a real Chromium browser into the app.
 *
 * Mirrors agentstation-app's approach: one `WebContentsView` per browser tab,
 * layered over the renderer's browser panel. The renderer measures the panel's
 * on-screen rectangle and drives show / hide / setBounds over IPC; navigation
 * and JS execution are forwarded straight to the view's WebContents.
 *
 * Unlike a `<webview>` tag, `WebContentsView` is a native view so it renders
 * above the React DOM and can load any site without CSP/frame-ancestor
 * interference. It needs no preload — it is a plain, isolated browser.
 */

import { ipcMain, WebContentsView } from 'electron';
import type { BrowserWindow } from 'electron';
import type { WindowManager } from './window-manager.js';
import { safeSend } from './safe-send.js';

// Channel names — MUST stay in sync with preload/index.ts and renderer.
export const BROWSER_CHANNELS = {
  CREATE: 'browser:create',
  DESTROY: 'browser:destroy',
  NAVIGATE: 'browser:navigate',
  GO_BACK: 'browser:goBack',
  GO_FORWARD: 'browser:goForward',
  RELOAD: 'browser:reload',
  STOP: 'browser:stop',
  EXECUTE_JS: 'browser:executeJavaScript',
  GET_PAGE_INFO: 'browser:getPageInfo',
  SET_BOUNDS: 'browser:setBounds',
  SHOW: 'browser:show',
  HIDE: 'browser:hide',
  // Push channels (main → renderer)
  EVENT: 'browser:event',
  OPEN_NEW_TAB: 'browser:open-new-tab',
} as const;

export interface BrowserViewManager {
  destroy(): void;
}

interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createBrowserViewManager(windowManager: WindowManager): BrowserViewManager {
  const views = new Map<string, WebContentsView>();
  let activeTabId: string | null = null;

  function mainWindow(): BrowserWindow | null {
    return windowManager.getMainWindow() ?? null;
  }

  function getView(tabId: string): WebContentsView {
    const view = views.get(tabId);
    if (!view) throw new Error(`Browser tab not found: ${tabId}`);
    return view;
  }

  function sendEvent(tabId: string, type: string, extra: Record<string, unknown> = {}): void {
    safeSend(mainWindow(), BROWSER_CHANNELS.EVENT, { tabId, type, ...extra });
  }

  function wireView(tabId: string, view: WebContentsView): void {
    const wc = view.webContents;

    wc.on('did-start-loading', () => sendEvent(tabId, 'did-start-loading'));
    wc.on('did-stop-loading', () => sendEvent(tabId, 'did-stop-loading'));
    wc.on('did-navigate', (_e, url) =>
      sendEvent(tabId, 'did-navigate', {
        url,
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
      }),
    );
    wc.on('did-navigate-in-page', (_e, url) =>
      sendEvent(tabId, 'did-navigate-in-page', {
        url,
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
      }),
    );
    wc.on('page-title-updated', (_e, title) => sendEvent(tabId, 'page-title-updated', { title }));
    // -3 is ERR_ABORTED — fires spuriously during redirects, so it is ignored.
    wc.on('did-fail-load', (_e, code, errorDescription) => {
      if (code === -3) return;
      sendEvent(tabId, 'did-fail-load', { errorDescription });
    });

    // Open target=_blank / window.open as new browser tabs instead of OS windows.
    wc.setWindowOpenHandler(({ url }) => {
      if (url) safeSend(mainWindow(), BROWSER_CHANNELS.OPEN_NEW_TAB, url);
      return { action: 'deny' };
    });
  }

  ipcMain.handle(BROWSER_CHANNELS.CREATE, (_e, { tabId, url }: { tabId: string; url: string }) => {
    // Re-showing an existing tab must not reload it — no-op when already created.
    if (views.has(tabId)) return;

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    // Opaque background so the view never renders transparently (e.g. while a
    // page is loading or on an error page).
    view.setBackgroundColor('#FFFFFF');
    wireView(tabId, view);
    views.set(tabId, view);
    // Not added to contentView yet — SHOW handles that.
    view.webContents.loadURL(url || 'about:blank').catch(() => {});
  });

  ipcMain.handle(BROWSER_CHANNELS.DESTROY, (_e, { tabId }: { tabId: string }) => {
    const view = views.get(tabId);
    if (view) {
      try {
        mainWindow()?.contentView.removeChildView(view);
      } catch {
        // Already detached — ignore.
      }
      // removeChildView only detaches; close() frees the renderer process.
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    views.delete(tabId);
    if (activeTabId === tabId) activeTabId = null;
  });

  ipcMain.handle(BROWSER_CHANNELS.NAVIGATE, (_e, { tabId, url }: { tabId: string; url: string }) => {
    getView(tabId).webContents.loadURL(url).catch(() => {});
  });

  ipcMain.handle(BROWSER_CHANNELS.GO_BACK, (_e, { tabId }: { tabId: string }) => {
    const wc = getView(tabId).webContents;
    if (wc.canGoBack()) wc.goBack();
  });

  ipcMain.handle(BROWSER_CHANNELS.GO_FORWARD, (_e, { tabId }: { tabId: string }) => {
    const wc = getView(tabId).webContents;
    if (wc.canGoForward()) wc.goForward();
  });

  ipcMain.handle(BROWSER_CHANNELS.RELOAD, (_e, { tabId }: { tabId: string }) => {
    getView(tabId).webContents.reload();
  });

  ipcMain.handle(BROWSER_CHANNELS.STOP, (_e, { tabId }: { tabId: string }) => {
    getView(tabId).webContents.stop();
  });

  ipcMain.handle(BROWSER_CHANNELS.EXECUTE_JS, (_e, { tabId, code }: { tabId: string; code: string }) => {
    return getView(tabId).webContents.executeJavaScript(code);
  });

  ipcMain.handle(BROWSER_CHANNELS.GET_PAGE_INFO, (_e, { tabId }: { tabId: string }) => {
    const wc = getView(tabId).webContents;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      isLoading: wc.isLoading(),
    };
  });

  ipcMain.handle(BROWSER_CHANNELS.SET_BOUNDS, (_e, { tabId, bounds }: { tabId: string; bounds: BrowserBounds }) => {
    const view = views.get(tabId);
    if (view) view.setBounds(bounds);
  });

  ipcMain.handle(
    BROWSER_CHANNELS.SHOW,
    (_e, { tabId, bounds }: { tabId: string; bounds?: BrowserBounds }) => {
      const win = mainWindow();
      const view = views.get(tabId);
      if (!win || !view) return;

      // Only one browser view is visible at a time — detach the previous one.
      if (activeTabId && activeTabId !== tabId) {
        const prev = views.get(activeTabId);
        if (prev) {
          try {
            win.contentView.removeChildView(prev);
          } catch {
            // ignore
          }
        }
      }

      if (activeTabId !== tabId) {
        win.contentView.addChildView(view);
      }
      if (bounds) view.setBounds(bounds);
      activeTabId = tabId;
    },
  );

  ipcMain.handle(BROWSER_CHANNELS.HIDE, (_e, { tabId }: { tabId: string }) => {
    const view = views.get(tabId);
    if (view) {
      try {
        mainWindow()?.contentView.removeChildView(view);
      } catch {
        // ignore
      }
    }
    if (activeTabId === tabId) activeTabId = null;
  });

  return {
    destroy(): void {
      const win = mainWindow();
      for (const [, view] of views) {
        try {
          win?.contentView.removeChildView(view);
        } catch {
          // ignore
        }
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }
      views.clear();
      activeTabId = null;

      const handlerChannels = Object.values(BROWSER_CHANNELS).filter(
        (ch) => ch !== BROWSER_CHANNELS.EVENT && ch !== BROWSER_CHANNELS.OPEN_NEW_TAB,
      );
      for (const channel of handlerChannels) {
        ipcMain.removeHandler(channel);
      }
    },
  };
}
