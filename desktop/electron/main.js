/**
 * Electron main process for Coderix Desktop (ESM — Electron 35+)
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron/main';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────

const SIDECAR_PORT = 9755;
const DEV_SERVER_PORT = 5173;
const isDev = process.argv.includes('--dev') || process.env['NODE_ENV'] === 'development';

// ── Globals ────────────────────────────────────────────────────────

let mainWindow = null;
let sidecarProcess = null;

// ── Sidecar management ─────────────────────────────────────────────

function startSidecar() {
  const coderixRoot = path.resolve(__dirname, '..', '..');
  const args = [
    'src/cli/main.tsx',
    '--desktop',
    '--desktop-port', String(SIDECAR_PORT),
  ];

  console.log('[electron] Starting coderix sidecar...');

  sidecarProcess = spawn('npx', ['tsx', ...args], {
    cwd: coderixRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  sidecarProcess.stdout.on('data', (data) => {
    process.stdout.write(`[sidecar] ${data}`);
  });

  sidecarProcess.stderr.on('data', (data) => {
    process.stderr.write(`[sidecar] ${data}`);
  });

  sidecarProcess.on('error', (err) => {
    console.error('[electron] Failed to start sidecar:', err.message);
  });

  sidecarProcess.on('exit', (code, signal) => {
    console.log(`[electron] Sidecar exited: code=${code} signal=${signal}`);
    sidecarProcess = null;
  });
}

function stopSidecar() {
  if (sidecarProcess) {
    console.log('[electron] Stopping sidecar...');
    sidecarProcess.kill('SIGTERM');
    setTimeout(() => {
      if (sidecarProcess) {
        sidecarProcess.kill('SIGKILL');
      }
    }, 3000);
  }
}

// ── Wait for sidecar ───────────────────────────────────────────────

function waitForSidecar(maxRetries = 30, interval = 1000) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const check = () => {
      retries++;
      const req = http.get(`http://127.0.0.1:${SIDECAR_PORT}`, () => {
        console.log('[electron] Sidecar is ready');
        resolve();
      });
      req.on('error', () => {
        if (retries >= maxRetries) {
          reject(new Error('Sidecar did not start in time'));
        } else {
          setTimeout(check, interval);
        }
      });
      req.end();
    };
    check();
  });
}

// ── Window ─────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    center: true,
    title: 'Coderix Desktop',
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        { label: 'New Session', accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu-new-session') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Coderix',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Coderix Desktop',
              message: 'Coderix Desktop v0.1.0',
              detail: 'A fully open-source AI programming assistant.\nBuilt with Electron + React.',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  if (isDev) {
    console.log(`[electron] Loading dev server: http://localhost:${DEV_SERVER_PORT}`);
    await mainWindow.loadURL(`http://localhost:${DEV_SERVER_PORT}`);
  } else {
    const distPath = path.resolve(__dirname, '..', 'dist');
    console.log(`[electron] Loading dist: ${distPath}`);
    await mainWindow.loadFile(path.join(distPath, 'index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ── App lifecycle ───────────────────────────────────────────────────

app.whenReady().then(async () => {
  startSidecar();

  try {
    await waitForSidecar();
  } catch (err) {
    console.error('[electron]', err.message);
  }

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopSidecar();
  app.quit();
});

app.on('before-quit', () => {
  stopSidecar();
});
