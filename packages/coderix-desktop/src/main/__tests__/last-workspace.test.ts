/**
 * Startup workspace restore.
 *
 * `getLastWorkspace()` used to accept only the default-workspace base, which
 * meant every restart reopened that base instead of the project the user was
 * actually in (projects live anywhere on disk). These pin the new rule: newest
 * existing directory wins, noise entries are skipped.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => {
  const app = {
    getPath: () => '/tmp/coderix-last-workspace-test',
    getVersion: () => '0.0.0-test',
    getName: () => 'coderix-test',
    on: () => {},
    whenReady: async () => {},
    quit: () => {},
    isPackaged: false,
  };
  const noop = () => {};
  return {
    ipcMain: { handle: noop, removeHandler: noop, on: noop, removeListener: noop },
    ipcRenderer: { on: noop, removeListener: noop, invoke: async () => undefined },
    contextBridge: { exposeInMainWorld: noop, exposeInIsolatedWorld: noop },
    BrowserWindow: class {},
    app,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop },
    default: { ipcMain: { handle: noop, removeHandler: noop, on: noop, removeListener: noop }, app },
  };
});

vi.mock('../claude-code-engine.js', () => ({
  runClaudeCodeQuery: () => undefined,
  getClaudeSessionId: () => undefined,
  getClaudeCumulativeUsage: () => undefined,
  loadClaudeSubagentTranscript: async () => [],
}));

vi.mock('../claude-code-runtime.js', () => ({
  claudeCodeRuntimeStatus: async () => ({ status: 'installed' }),
  ensureClaudeCodeInstalled: async () => ({ status: 'installed' }),
}));

// recent_projects.json is resolved from homedir() at import time.
const home = mkdtempSync(join(tmpdir(), 'coderix-last-workspace-'));
const previousHome = process.env.HOME;
process.env.HOME = home;

const { getLastWorkspace } = await import('../ipc-bridge.js');
const { writeFileSync: writeFile } = await import('node:fs');

const projectA = join(home, 'projects', 'alpha');
const defaultBase = join(home, 'projects', 'default-base');
const aFile = join(home, 'not-a-dir.txt');
mkdirSync(projectA, { recursive: true });
mkdirSync(defaultBase, { recursive: true });
writeFileSync(aFile, 'x');

function setRecent(paths: string[]): void {
  mkdirSync(join(home, '.coderix'), { recursive: true });
  writeFile(join(home, '.coderix', 'recent_projects.json'), JSON.stringify(paths), 'utf-8');
}

afterAll(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('getLastWorkspace', () => {
  it('restores an external project instead of the default workspace base', () => {
    setRecent([projectA, defaultBase]);
    // alpha comes first, so it wins — and it is not inside the default base.
    expect(getLastWorkspace()).toBe(projectA);
  });

  it('skips missing paths, files, the launch dir and the filesystem root', () => {
    setRecent([
      join(home, 'gone'),
      aFile,
      process.cwd(),
      '/',
      defaultBase,
    ]);
    expect(getLastWorkspace()).toBe(defaultBase);
  });

  it('returns undefined when nothing usable is recorded', () => {
    setRecent([join(home, 'gone'), aFile, '/']);
    expect(getLastWorkspace()).toBeUndefined();
  });
});
