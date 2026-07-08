/**
 * providers/script.ts — ScriptProvider
 *
 * Executes hooks by spawning a child process for each hook.  The hook
 * context is written as JSON to stdin and the structured result is read
 * as JSON from stdout.  This provides full process-level isolation.
 *
 * Fail-open design: if the script crashes, times out, or returns
 * non-JSON output, an empty result is returned so the main flow
 * is never blocked by a buggy hook.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type {
  HookDefinition,
  HookContext,
  HookProvider,
  HookResult,
} from '../types.js';
import { IS_WINDOWS } from '../../utils/platform.js';

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

/** Default timeout when none is specified in the hook definition. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Max bytes to read from stdout before giving up. */
const MAX_STDOUT_BYTES = 64 * 1024; // 64 KiB

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Kill a child process and its descendants.
 * On Windows, uses TerminateProcess (no process group kill available).
 * On Unix, sends SIGTERM to the process group.
 */
function killProcessTree(child: ChildProcess): void {
  if (IS_WINDOWS) {
    child.kill(); // TerminateProcess
  } else {
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ScriptProvider
// ═══════════════════════════════════════════════════════════════════

export class ScriptProvider implements HookProvider {
  readonly name = 'script';

  async execute(
    hook: HookDefinition,
    context: HookContext,
  ): Promise<Partial<HookResult>> {
    const timeout = hook.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      let settled = false;

      const child = spawn(hook.command, [], {
        shell: true,  // Allow quoted args, pipes, etc. — user-friendly
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...hook.env, NoDefaultCurrentDirectoryInExePath: '1' },
        windowsHide: true,
        // detached so we can kill the process group on timeout (Unix)
        detached: true,
      });

      // ── Timeout guard ──
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcessTree(child);
        resolve({});
      }, timeout);

      // ── Collect stdout ──
      let stdout = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
        // Guard against runaway output
        if (stdout.length > MAX_STDOUT_BYTES) {
          stdout = stdout.slice(0, MAX_STDOUT_BYTES);
          killProcessTree(child);
        }
      });

      // ── Collect stderr (for debug logging only) ──
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });

      // ── Write context to stdin ──
      child.stdin!.write(JSON.stringify(context));
      child.stdin!.end();

      // ── Handle exit ──
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        // Fail-open: non-zero exit or empty stdout → no-op result
        if (code !== 0 || !stdout.trim()) {
          if (stderr.trim()) {
            // Hook failure is non-fatal; log for debugging but don't block
            // (caller is responsible for structured logging)
          }
          resolve({});
          return;
        }

        // Parse JSON result
        try {
          const result = JSON.parse(stdout.trim()) as Partial<HookResult>;
          resolve(result);
        } catch {
          // Invalid JSON → fail-open
          resolve({});
        }
      });

      // ── Handle spawn errors ──
      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({});
      });
    });
  }
}
