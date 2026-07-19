import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolExecutor, ToolResult } from '../types.js';
import type { ToolRequestEvent } from '../../state/observable.js';
import { registerTask, updateTask, notifyTaskCompletion } from '../../tasks/task-tracker.js';
import type { TrackedTask } from '../../tasks/task-tracker.js';
import {
  tokenizeCommand,
  extractCommandTokens,
  type TokenizeResult,
} from './command-tokenizer.js';
import { CommandCategory, type ClassificationResult } from './command-classifier.js';
import { IS_WINDOWS } from '../../utils/platform.js';
import { toPosixPath } from '../../utils/windows-paths.js';
import { detectShell } from '../../utils/shell-detect.js';

// ── Shell resolution (cached at module load) ─────────────────────────────

/** The shell binary to use for command execution. */
const RESOLVED_SHELL: string | true = (() => {
  if (!IS_WINDOWS) return true; // On Unix, `shell: true` uses $SHELL
  const shell = detectShell();
  // Use the detected shell if it's available; fall back to default
  if (shell.type === 'git-bash' || shell.type === 'pwsh' || shell.type === 'powershell') {
    return shell.path;
  }
  return true; // fallback to cmd.exe via COMSPEC
})();

/** Whether the resolved shell understands POSIX syntax (bash/zsh/sh). */
const IS_POSIX_SHELL: boolean = IS_WINDOWS
  ? detectShell().type === 'git-bash'
  : true;

// ── Spawn defaults ──────────────────────────────────────────────────────

/** Options applied to every spawn() on every platform. */
const SPAWN_DEFAULTS = {
  windowsHide: true,
  shell: RESOLVED_SHELL,
  env: {
    ...process.env,
    // Prevent Windows from searching CWD for executables (DLL hijacking mitigation)
    NoDefaultCurrentDirectoryInExePath: '1',
  },
} as const;

// ── Command preprocessing ────────────────────────────────────────────────

/**
 * Regex matching Windows cmd-style null redirects (e.g., `2>nul`, `>NUL`).
 * On Git Bash these would create a literal file named `nul` — a reserved
 * Windows device name that is extremely hard to delete.  Rewrite to
 * POSIX `/dev/null` which Git Bash handles correctly.
 */
const NUL_REDIRECT_RE = /(\d?&?>+)\s*[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

/**
 * Regex matching quoted Windows paths: "C:\Program Files\app".
 * Handled first so spaces within quotes are safe.
 */
const QUOTED_WIN_PATH_RE = /(["'])([A-Za-z]:[\\/][\w.\- \\/]+?)\1/g;

/**
 * Regex matching unquoted Windows paths without spaces.
 * After quoted paths are processed, this handles the rest.
 */
const UNQUOTED_WIN_PATH_RE = /[A-Za-z]:[\\/][\w.\-\\/]+(?=\s|$|"|'|`|;|&|\||\)|\n)/g;

/**
 * Preprocess a shell command before execution.
 * - If the shell is POSIX (Git Bash on Windows, or any Unix shell):
 *   rewrites cmd-style null redirects (2>nul → 2>/dev/null) and converts
 *   Windows paths to POSIX form.
 * - If the shell is cmd.exe or PowerShell: no conversion needed; the shell
 *   understands Windows paths and cmd-style redirects natively.
 */
function preprocessCommand(command: string): string {
  if (!IS_WINDOWS || !IS_POSIX_SHELL) return command;
  let result = command;
  // 1. Rewrite Windows null redirects (2>nul → 2>/dev/null)
  result = result.replace(NUL_REDIRECT_RE, '$1/dev/null');
  // 2. Convert quoted Windows paths (spaces are safe inside quotes)
  result = result.replace(QUOTED_WIN_PATH_RE, (_full, quote, path) => quote + toPosixPath(path) + quote);
  // 3. Convert unquoted Windows paths (no spaces in these)
  result = result.replace(UNQUOTED_WIN_PATH_RE, (match) => toPosixPath(match));
  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────

let _reqIdCounter = 0;
function nextRequestId(): string {
  return `bash_${++_reqIdCounter}_${Date.now()}`;
}

/** Emit a background task update to the frontend via EventBus. */
function emitTaskUpdate(
  emit: ((req: ToolRequestEvent) => void) | undefined,
  taskId: string,
  task: TrackedTask,
): void {
  if (!emit) return;
  emit({
    type: 'background_task_update',
    taskId,
    task: task as unknown as Record<string, unknown>,
    requestId: nextRequestId(),
  });
}

// ── Security check hook ─────────────────────────────────────────────

/**
 * Result of a pre-execution security check on a bash command.
 */
export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
  classification: ClassificationResult;
}

/**
 * Pre-execution security check function signature.
 *
 * When installed (via setPreExecSecurityCheck), this function is called
 * for EVERY bash command BEFORE spawn(). It receives the raw command,
 * tokenized tokens, and executor options.
 *
 * Return `{ allowed: false }` to block execution. The reason string
 * is returned to the LLM as an error.
 */
export type PreExecSecurityCheck = (
  command: string,
  tokens: string[],
  cwd: string,
) => SecurityCheckResult | Promise<SecurityCheckResult>;

/** Module-level security check hook. Set by the security system at boot. */
let _securityCheckHook: PreExecSecurityCheck | null = null;

/**
 * Install the pre-execution security check hook.
 * Called by index.ts or security-check.ts at plugin load time.
 */
export function setPreExecSecurityCheck(fn: PreExecSecurityCheck): void {
  _securityCheckHook = fn;
}

/**
 * Get the currently installed security check hook (for testing).
 */
export function getPreExecSecurityCheck(): PreExecSecurityCheck | null {
  return _securityCheckHook;
}

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
  collector?: { stdout: string; stderr: string };
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      ...SPAWN_DEFAULTS,
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...SPAWN_DEFAULTS.env },
    });

    const output = { stdout: '', stderr: '' };
    let settled = false;
    let autoBackgrounded = false;

    const finish = (error: Error | null, exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(autoBgTimer);
      resolve({ stdout: output.stdout, stderr: output.stderr, exitCode, signal, error, pid: child.pid ?? 0, child, autoBackgrounded, collector: output });
    };

    // Auto-background: detach listeners so the process keeps running,
    // then resolve immediately so the caller can register it as a background task.
    const doAutoBackground = () => {
      if (settled) return;
      settled = true;
      autoBackgrounded = true;
      clearTimeout(timer);
      clearTimeout(autoBgTimer);
      // Keep data listeners attached so output continues to accumulate
      child.removeAllListeners('close');
      child.removeAllListeners('error');
      resolve({ stdout: output.stdout, stderr: output.stderr, exitCode: null, signal: null, error: null, pid: child.pid ?? 0, child, autoBackgrounded, collector: output });
    };

    // Auto-background after 15 seconds of running
    const autoBgTimer = setTimeout(doAutoBackground, AUTO_BG_MS);

    // Timeout also triggers auto-background instead of killing the process
    const timer = setTimeout(doAutoBackground, opts.timeout);

    child.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      if (output.stdout.length < opts.maxBuffer) {
        output.stdout += str;
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      if (output.stderr.length < opts.maxBuffer) {
        output.stderr += str;
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
  /** Live collector — continues capturing output after the promise resolves. */
  collector: { stdout: string; stderr: string };
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      ...SPAWN_DEFAULTS,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...SPAWN_DEFAULTS.env },
      detached: true,
    });

    const collector = { stdout: '', stderr: '' };
    let settled = false;

    const capture = () => {
      if (settled) return;
      settled = true;
      child.removeAllListeners('close');
      child.removeAllListeners('error');
      resolve({
        stdout: collector.stdout,
        stderr: collector.stderr,
        exitCode: child.exitCode,
        error: null,
        pid: child.pid ?? 0,
        child,
        collector,
      });
    };

    // Accumulate output indefinitely (listeners stay attached after capture)
    child.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      if (collector.stdout.length < opts.maxBuffer) collector.stdout += str;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      if (collector.stderr.length < opts.maxBuffer) collector.stderr += str;
    });

    // If the process exits during the capture window, resolve immediately
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        resolve({
          stdout: collector.stdout,
          stderr: collector.stderr,
          exitCode: code,
          error: null,
          pid: child.pid ?? 0,
          child,
          collector,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ stdout: collector.stdout, stderr: collector.stderr, exitCode: null, error: err, pid: 0, child, collector });
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

  const rawCommand = input.command as string;
  if (!rawCommand) return { content: 'Error: command is required', isError: true };

  // Preprocess: rewrite Windows-isms for Git Bash compatibility.
  // Security check runs on the raw (unprocessed) command, so classifiers
  // see what the LLM actually wrote.  Path conversion and null-redirect
  // rewriting happen just before spawn.
  const command = preprocessCommand(rawCommand);

  // ── Pre-execution security check ──────────────────────────────
  // Tokenize the command, then run the security check hook (if installed).
  // This blocks dangerous commands BEFORE they reach spawn().
  const tokenizeResult = tokenizeCommand(command);
  let tokens: string[] = [];
  let classification: ClassificationResult | undefined;

  if (tokenizeResult.success) {
    tokens = extractCommandTokens(tokenizeResult.entries);
  }
  // On tokenization failure, tokens stays empty and the hook
  // receives an empty array — it should treat this as UNKNOWN.

  if (_securityCheckHook) {
    const result = await _securityCheckHook(command, tokens, opts.cwd);
    classification = result.classification;

    if (!result.allowed) {
      const reason = result.reason || 'Command blocked by security check';
      return {
        content: `Error: ${reason}`,
        isError: true,
        duration: 0,
        metadata: {
          command,
          securityBlocked: true,
          classification: result.classification,
        },
      };
    }
  }

  // If no hook installed, classification stays undefined (backward compat)
  if (!classification) {
    classification = {
      category: CommandCategory.UNKNOWN,
      isReadOnly: false,
      isConcurrencySafe: false,
      reason: 'No security check installed',
    };
  }

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
          metadata: { command, exitCode: result.exitCode ?? null, stderr: stderr || undefined, background: true, classification },
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
      emitTaskUpdate(opts.emitToolRequest, taskId, trackedTask);

      // Listen for process exit to update tracker
      result.child.on('close', (code: number | null) => {
        const newStatus: 'done' | 'error' = code === 0 ? 'done' : 'error';
        const fullOutput = [result.collector.stdout, result.collector.stderr].filter(Boolean).join('\n');
        updateTask(taskId, { status: newStatus, finishedAt: Date.now(), result: fullOutput });
        emitTaskUpdate(opts.emitToolRequest, taskId, {
          ...trackedTask,
          status: newStatus,
          finishedAt: Date.now(),
          result: fullOutput,
        });
        notifyTaskCompletion(taskId);
        result.child.unref();
      });

      const statusLine = `Command started in background (task_id: ${taskId}, pid: ${result.pid}). Captured output after ${BG_CAPTURE_MS}ms:\n`;
      return {
        content: statusLine + (output || '(no output yet)'),
        isError: false,
        duration,
        metadata: { command, pid: result.pid, background: true, task_id: taskId, classification },
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
      emitTaskUpdate(opts.emitToolRequest, taskId, trackedTask);

      result.child.on('close', (code: number | null) => {
        const newStatus: 'done' | 'error' = code === 0 ? 'done' : 'error';
        const fullOutput = [result.collector?.stdout ?? result.stdout, result.collector?.stderr ?? result.stderr].filter(Boolean).join('\n');
        updateTask(taskId, { status: newStatus, finishedAt: Date.now(), result: fullOutput });
        emitTaskUpdate(opts.emitToolRequest, taskId, {
          ...trackedTask,
          status: newStatus,
          finishedAt: Date.now(),
          result: fullOutput,
        });
        notifyTaskCompletion(taskId);
        result.child.unref();
      });
      const statusLine = `Command auto-backgrounded after ${AUTO_BG_MS / 1000}s (task_id: ${taskId}, pid: ${result.pid}). Captured output:\n`;
      return {
        content: statusLine + (output || '(no output yet)'),
        isError: false,
        duration,
        metadata: { command, pid: result.pid, background: true, autoBackgrounded: true, task_id: taskId, classification },
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
        classification,
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