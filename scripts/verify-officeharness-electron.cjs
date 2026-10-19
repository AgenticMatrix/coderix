#!/usr/bin/env node
/**
 * verify-officeharness-electron.cjs — load the OfficeHarness workspace in a
 * hidden Electron window and assert the cross-origin isolation the WASM engine
 * requires.
 *
 * This is the same Chromium path the app's WebContentsView uses, without
 * showing a window. Run with the repository's Electron binary:
 *   node_modules/.bin/electron scripts/verify-officeharness-electron.cjs
 */

const { app, BrowserWindow } = require('electron');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const PLUGIN =
  process.env.OFFICEHARNESS_PLUGIN_DIR ??
  path.join(HOME, 'Documents', 'apps', 'OfficeHarness', 'officeharness_plugins', 'office-harness');
const PROFILE =
  process.env.OFFICEHARNESS_PROFILE_DIR ?? path.join(HOME, '.coderix', 'officeharness', 'embedded');
const ASSETS = path.join(PLUGIN, 'host', 'assets');
const requireCjs = createRequire(__filename);

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

async function main() {
  const { ensureHost, attachClient } = requireCjs(path.join(PLUGIN, 'host', 'managed-host.cjs'));
  const service = await ensureHost({
    profile: PROFILE,
    root: ASSETS,
    packageRoot: PLUGIN,
    port: 0,
    idleGraceMs: 120_000,
  });
  const lease = await attachClient({ profile: PROFILE, root: ASSETS, service, kind: 'preview' });
  console.log(`OK   host ${service.url} (pid ${service.pid})`);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:browser',
    },
  });

  try {
    await win.loadURL(service.url);
    // Give the inline boot scripts one turn to run before inspecting globals.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await win.webContents.executeJavaScript(`({
      isolated: crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer,
      webassembly: typeof WebAssembly,
      token: typeof window.OFFICE_TOKEN === 'string' && window.OFFICE_TOKEN.length > 0,
      title: document.title,
      loading: Boolean(document.getElementById('loading'))
    })`);
    console.log(JSON.stringify(result));
    if (!result.isolated) fail('crossOriginIsolated is false');
    if (result.sharedArrayBuffer !== 'function') fail('SharedArrayBuffer unavailable');
    if (result.webassembly !== 'object') fail('WebAssembly unavailable');
    if (!result.token) fail('workspace token missing');
  } finally {
    await lease.release().catch(() => {});
    win.destroy();
    if (service.started) {
      try {
        process.kill(service.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => app.quit(), 300).unref();
  });
