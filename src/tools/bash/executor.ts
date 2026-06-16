import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolExecutor, ToolResult } from '../types.js';
import { registerTask, updateTask, syncTaskToAppState } from '../../tasks/task-tracker.js';
import type { TrackedTask } from '../../tasks/task-tracker.js';

const BG_CAPTURE_MS = 3000;
const AUTO_BG_MS = 15000; // 15 seconds before auto-backgrounding

function isErrorStatus(status: number | null): boolean {
  return status !== 0;
}

function runCommand(command: string, opts: {
  cwd: string;
  timeout: number;
  maxBuffer: number;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  error: Error | null;
  pid: number;
  child: ChildProcess;
  autoBackgrounded: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let autoBackgrounded = false;

    const finish = (error: Error | null, exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(autoBgTimer);
      resolve({ stdout, stderr, exitCode, signal, error, pid: child.pid ?? 0, child, autoBackgrounded });
    };

    // Auto-background: detach listeners so the process keeps running,
    // then resolve immediately so the caller can register it as a background task.
    const doAutoBackground = () => {
      if (settled) return;
      settled = true;
      autoBackgrounded = true;
      clearTimeout(timer);
      clearTimeout(autoBgTimer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('close');
      child.removeAllListeners('error');
      resolve({ stdout, stderr, exitCode: null, signal: null, error: null, pid: child.pid ?? 0, child, autoBackgrounded });
    };

    // Auto-background after 15 seconds of running
    const autoBgTimer = setTimeout(doAutoBackground, AUTO_BG_MS);

    // Timeout also triggers auto-background instead of killing the process
    const timer = setTimeout(doAutoBackground, opts.timeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      if (stdout.length < opts.maxBuffer) {
        stdout += str;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      if (stderr.length < opts.maxBuffer) {
        stderr += str;
      }
    });

    child.on('error', (err) => {
      finish(err, null, null);
    });

    child.on('close', (code, sig) => {
      finish(null, code, sig);
    });
  });
}

/**
 * Spawn a command in background: capture output briefly, then resolve
 * WITHOUT killing the process. The process keeps running detached.
 */
function runBackgroundCommand(command: string, opts: {
  cwd: string;
  maxBuffer: number;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: Error | null;
  pid: number;
  child: ChildProcess;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const capture = () => {
      if (settled) return;
      settled = true;
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('close');
      child.removeAllListeners('error');
      resolve({
        stdout,
        stderr,
        exitCode: child.exitCode,
        error: null,
        pid: child.pid ?? 0,
        child,
      });
    };

    // Capture output during the window
    child.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      if (stdout.length < opts.maxBuffer) stdout += str;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      if (stderr.length < opts.maxBuffer) stderr += str;
    });

    // If the process exits during the capture window, resolve immediately
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        resolve({
          stdout,
          stderr,
          exitCode: code,
          error: null,
          pid: child.pid ?? 0,
          child,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: null, error: err, pid: 0, child });
      }
    });

    // After the capture window, resolve WITHOUT killing
    const timer = setTimeout(capture, BG_CAPTURE_MS);
  });
}

export const execute: ToolExecutor = async (input, opts): Promise<ToolResult> => {
  if (!opts.allowMutation) {
    return { content: 'Error: bash tool is not available (mutation tools disabled)', isError: true };
  }

  const command = input.command as string;
  if (!command) return { content: 'Error: command is required', isError: true };

  const runInBackground = input.run_in_background as boolean | undefined;
  const timeout = (input.timeout as number) ?? opts.bashTimeout;
  const startTime = Date.now();

  try {
    if (runInBackground) {
      const result = await runBackgroundCommand(command, {
        cwd: opts.cwd,
        maxBuffer: opts.maxOutput,
      });

      const duration = Date.now() - startTime;
      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      const exited = result.exitCode !== null;

      if (result.error) {
        return {
          content: `Error spawning background command: ${result.error.message}`,
          isError: true,
          duration,
          metadata: { command },
        };
      }

      if (exited) {
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: output || '(no output)',
          isError: isErrorStatus(result.exitCode),
          duration,
          metadata: { command, exitCode: result.exitCode ?? null, stderr: stderr || undefined, background: true },
        };
      }

      const output = [stdout, stderr].filter(Boolean).join('\n');
      const taskId = `bash-${result.pid}`;

      // Register with tracker for TaskOutput / TaskStop
      const trackedTask = {
        id: taskId,
        type: 'bash' as const,
        status: 'running' as const,
        description: command.slice(0, 120),
        process: result.child,
        createdAt: startTime,
      };
      registerTask(trackedTask);

      // Dual-write to AppState (Phase 2 bridge)
      if (opts.setAppState && opts.getAppState) {
        syncTaskToAppState(opts.setAppState, opts.getAppState, trackedTask, 'register');
      }

      // Listen for process exit to update tracker
      result.child.on('close', (code: number | null) => {
        const newStatus: 'done' | 'error' = code === 0 ? 'done' : 'error';
        const updatedTask: TrackedTask = {
          ...trackedTask,
          status: newStatus,
          finishedAt: Date.now(),
        };
        updateTask(taskId, { status: newStatus, finishedAt: Date.now() });
        // Dual-write to AppState
        if (opts.setAppState && opts.getAppState) {
          syncTaskToAppState(opts.setAppState, opts.getAppState, updatedTask, 'update');
        }
        result.child.unref();
      });

      const statusLine = `Command started in background (pid ${result.pid}). Captured output after ${BG_CAPTURE_MS}ms:\n`;
      return {
        content: statusLine + (output || '(no output yet)'),
        isError: false,
        duration,
        metadata: { command, pid: result.pid, background: true, task_id: taskId },
      };
    }

    // Foreground mode: wait for completion or auto-background
    const result = await runCommand(command, {
      cwd: opts.cwd,
      timeout,
      maxBuffer: opts.maxOutput,
    });

    const duration = Date.now() - startTime;
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    const exitCode = result.exitCode;
    const error = result.error;

    if (error) {
      return {
        content: `Error: ${error.message}`,
        isError: true,
        duration,
        metadata: { command, exitCode, stderr: stderr || undefined },
      };
    }

    // Command was auto-backgrounded (ran > 15s or hit timeout) — register as background task
    if (result.autoBackgrounded) {
      const output = [stdout, stderr].filter(Boolean).join('\n');
      const taskId = `bash-${result.pid}`;

      const trackedTask: TrackedTask = {
        id: taskId,
        type: 'bash' as const,
        status: 'running' as const,
        description: command.slice(0, 120),
        process: result.child,
        createdAt: startTime,
      };
      registerTask(trackedTask);

      if (opts.setAppState && opts.getAppState) {
        syncTaskToAppState(opts.setAppState, opts.getAppState, trackedTask, 'register');
      }

      result.child.on('close', (code: number | null) => {
        const newStatus: 'done' | 'error' = code === 0 ? 'done' : 'error';
        const updatedTask: TrackedTask = {
          ...trackedTask,
          status: newStatus,
          finishedAt: Date.now(),
        };
        updateTask(taskId, { status: newStatus, finishedAt: Date.now() });
        if (opts.setAppState && opts.getAppState) {
          syncTaskToAppState(opts.setAppState, opts.getAppState, updatedTask, 'update');
        }
        result.child.unref();
      });

      const statusLine = `Command auto-backgrounded after ${AUTO_BG_MS / 1000}s (pid ${result.pid}). Captured output:\n`;
      return {
        content: statusLine + (output || '(no output yet)'),
        isError: false,
        duration,
        metadata: { command, pid: result.pid, background: true, autoBackgrounded: true, task_id: taskId },
      };
    }

    return {
      content: stdout || (isErrorStatus(exitCode) ? '(command produced no output)' : ''),
      isError: isErrorStatus(exitCode),
      duration,
      metadata: {
        command,
        exitCode: exitCode ?? null,
        stderr: stderr || undefined,
      },
    };
  } catch (err) {
    const duration = Date.now() - startTime;
    return {
      content: `Error: ${(err as Error).message}`,
      isError: true,
      duration,
      metadata: { command },
    };
  }
};