/**
 * Platform detection and cross-platform helpers.
 *
 * Centralizes all `process.platform` checks so the rest of the codebase
 * can import a single constant instead of sprinkling platform guards.
 */

export const IS_WINDOWS: boolean = process.platform === 'win32';

export const IS_MACOS: boolean = process.platform === 'darwin';

export const IS_LINUX: boolean = process.platform === 'linux';

/**
 * Resolves when the process should shut down.
 * On Unix: stdin close + SIGTERM/SIGINT. On Windows: stdin close only.
 */
export function onShutdownSignal(callback: () => void): void {
  process.stdin.on('end', callback);
  if (!IS_WINDOWS) {
    process.on('SIGTERM', callback);
    process.on('SIGINT', callback);
  }
}
