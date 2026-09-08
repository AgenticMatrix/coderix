/**
 * Safe IPC send helpers — guard against sending to a disposed renderer frame.
 *
 * `webContents.send()` reaches into `webFrameMain`, which throws
 * "Render frame was disposed before WebFrameMain could be accessed" when the
 * renderer process has crashed or navigated away (the common cause of a blank
 * white window). Every main→renderer push should go through these helpers so a
 * crashed renderer can't spam the main process with that error.
 */

import type { BrowserWindow } from 'electron';

/** Returns true if the window's renderer can currently receive IPC. */
export function isSendable(win: BrowserWindow | null | undefined): win is BrowserWindow {
  if (!win || win.isDestroyed()) return false;
  if (win.webContents.isDestroyed()) return false;
  return true;
}

/**
 * Send an IPC message to a window's renderer, swallowing frame-disposed errors.
 * If the renderer has crashed or navigated away, the message is dropped.
 */
export function safeSend(
  win: BrowserWindow | null | undefined,
  channel: string,
  ...args: unknown[]
): void {
  if (!isSendable(win)) return;
  try {
    win.webContents.send(channel, ...args);
  } catch {
    // Renderer crashed or navigated away mid-send — drop the message.
  }
}
