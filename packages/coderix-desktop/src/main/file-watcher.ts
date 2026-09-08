/**
 * File Watcher — chokidar-based file system monitoring
 *
 * ADR-001 §3.3: Watches project directory for file changes,
 * debounces rapid writes, and pushes events to the renderer
 * via IPC for File Explorer updates.
 *
 * Dependencies: chokidar (npm package)
 *
 * NOTE: chokidar must be added to package.json dependencies:
 *   pnpm add chokidar --filter @coderix/desktop
 */

import { relative } from 'node:path';
import type { FSWatcher } from 'chokidar';
import { BrowserWindow } from 'electron';
import { safeSend } from './safe-send.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileChangeEvent {
  event: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  path: string;
  relativePath: string;
  timestamp: number;
}

export interface FileWatcherConfig {
  /** Root directory to watch. */
  cwd: string;
  /** Patterns to ignore (in addition to defaults). */
  extraIgnores?: string[];
  /** Debounce threshold in milliseconds. */
  stabilityThreshold?: number;
}

export interface FileWatcherManager {
  /** Start watching a directory. Returns a watcher ID. */
  watch(watchPath: string, config?: Partial<FileWatcherConfig>): Promise<string>;
  /** Stop watching by ID. */
  unwatch(watcherId: string): void;
  /** Register a BrowserWindow to receive push events. */
  setMainWindow(window: BrowserWindow): void;
  /** Destroy all watchers. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Default ignore patterns
// ---------------------------------------------------------------------------

const DEFAULT_IGNORED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.coderix/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/.DS_Store',
  '**/Thumbs.db',
];

// ---------------------------------------------------------------------------
// createFileWatcherManager
// ---------------------------------------------------------------------------

export function createFileWatcherManager(): FileWatcherManager {
  const watchers = new Map<string, FSWatcher>();
  let mainWindow: BrowserWindow | null = null;
  let chokidarModule: typeof import('chokidar') | null = null;

  async function getChokidar(): Promise<typeof import('chokidar')> {
    if (chokidarModule) return chokidarModule;
    chokidarModule = await import('chokidar');
    return chokidarModule!;
  }

  function sendToRenderer(event: FileChangeEvent): void {
    safeSend(mainWindow, 'fs:fileChanged', event);
  }

  return {
    setMainWindow(window: BrowserWindow): void {
      mainWindow = window;
    },

    async watch(watchPath: string, config?: Partial<FileWatcherConfig>): Promise<string> {
      const chokidar = await getChokidar();

      const mergedConfig: FileWatcherConfig = {
        cwd: watchPath,
        extraIgnores: [],
        stabilityThreshold: 100,
        ...config,
      };

      const watcher = chokidar.watch(watchPath, {
        ignored: [
          ...DEFAULT_IGNORED,
          ...(mergedConfig.extraIgnores ?? []),
        ],
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: mergedConfig.stabilityThreshold ?? 100,
          pollInterval: 10,
        },
        // Don't follow symlinks by default
        followSymlinks: false,
      });

      const watcherId = `watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      watcher.on('all', (event: string, path: string) => {
        const validEvents = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'];
        if (!validEvents.includes(event)) return;

        const relativePath = relative(watchPath, path);

        sendToRenderer({
          event: event as FileChangeEvent['event'],
          path,
          relativePath,
          timestamp: Date.now(),
        });
      });

      watcher.on('error', (error: unknown) => {
        console.error(`[FileWatcher ${watcherId}] Error:`, String(error));
      });

      watchers.set(watcherId, watcher);

      // Return immediately, don't wait for ready event
      return watcherId;
    },

    unwatch(watcherId: string): void {
      const watcher = watchers.get(watcherId);
      if (watcher) {
        watcher.close();
        watchers.delete(watcherId);
      }
    },

    destroy(): void {
      for (const [id, watcher] of watchers) {
        try {
          watcher.close();
        } catch (err) {
          console.error(`[FileWatcher] Error closing watcher ${id}:`, err);
        }
      }
      watchers.clear();
      mainWindow = null;
    },
  };
}
