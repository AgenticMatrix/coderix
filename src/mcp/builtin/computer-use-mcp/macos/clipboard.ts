/**
 * macOS Clipboard — pbpaste / pbcopy wrapper.
 *
 * Reads and writes the system pasteboard.
 */

import { execSync, spawn } from 'node:child_process';

/**
 * Read the current system clipboard content.
 */
export function readClipboard(): string {
  const result = execSync('pbpaste', {
    timeout: 5000,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  return result;
}

/**
 * Write text to the system clipboard.
 */
export function writeClipboard(text: string): void {
  const child = spawn('pbcopy', [], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.write(text);
  child.stdin.end();
}
