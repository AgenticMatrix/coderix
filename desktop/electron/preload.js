/**
 * Electron preload script (ESM) — exposes safe IPC to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron/main';

contextBridge.exposeInMainWorld('electronAPI', {
  onMenuNewSession: (callback) => ipcRenderer.on('menu-new-session', callback),
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  saveFileDialog: () => ipcRenderer.invoke('dialog:saveFile'),
  platform: process.platform,
});
