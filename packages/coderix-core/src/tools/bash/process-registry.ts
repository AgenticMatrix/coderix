/**
 * Registry of bash child processes, grouped by owning session.
 *
 * The bash tool backgrounds commands instead of blocking the turn, so without
 * an explicit owner a long command outlives the turn, the session and even the
 * app process. Every spawned child is registered here; callers kill a session's
 * tree on interrupt / delete and all trees on quit.
 *
 * `tree-kill` walks the process tree, which matters because `shell: true`
 * means the real work runs in a grandchild of the process we spawned.
 */

import treeKill from 'tree-kill';
import type { ChildProcess } from 'node:child_process';

let exitHookInstalled = false;
let signalHooksInstalled = false;

/**
 * Force-kill every tracked tree without grace. Runs from an 'exit' handler or
 * a signal handler, where timers never fire.
 */
function killAllSync(): void {
  for (const group of bySession.values()) {
    for (const entry of group) {
      const pid = entry.child.pid;
      if (!pid) continue;
      if (entry.processGroup) {
        try {
          process.kill(-pid, 'SIGKILL');
          continue;
        } catch {
          // Group already gone; fall back to the direct handle.
        }
      }
      try {
        entry.child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
    }
  }
}

function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', killAllSync);
}

export interface RegisterProcessOptions {
  sessionId: string;
  /**
   * The child was spawned detached on POSIX, so it leads its own process
   * group. Signalling the group reaches grandchildren that would otherwise
   * survive their shell and be reparented away from us.
   */
  processGroup: boolean;
}

interface TrackedChild extends RegisterProcessOptions {
  child: ChildProcess;
}

const bySession = new Map<string, Set<TrackedChild>>();
const byChild = new Map<ChildProcess, TrackedChild>();

/** Signal one process tree, preferring the child's own process group. */
function signalTree(pid: number, processGroup: boolean, sig: NodeJS.Signals): void {
  if (processGroup) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // Group already gone, or the pid never led one: fall back to the tree.
    }
  }
  treeKill(pid, sig, () => {});
}

/** Give the process tree a chance to exit cleanly, then force it. */
function killTree(pid: number | undefined, processGroup: boolean): void {
  if (!pid) return;
  signalTree(pid, processGroup, 'SIGTERM');
  const timer = setTimeout(() => signalTree(pid, processGroup, 'SIGKILL'), 1500);
  timer.unref?.();
}

export function registerProcess(child: ChildProcess, opts: RegisterProcessOptions): void {
  const entry: TrackedChild = { child, ...opts };
  let group = bySession.get(opts.sessionId);
  if (!group) {
    group = new Set();
    bySession.set(opts.sessionId, group);
  }
  group.add(entry);
  byChild.set(child, entry);
  ensureExitHook();

  // 'exit' (not 'close') because auto-backgrounding deliberately detaches the
  // 'close' listeners while the process keeps running.
  child.once('exit', () => unregisterProcess(child));
  // A spawn failure (ENOENT) may never emit 'exit'.
  child.once('error', () => unregisterProcess(child));
}

export function unregisterProcess(child: ChildProcess): void {
  const entry = byChild.get(child);
  if (!entry) return;
  byChild.delete(child);
  const group = bySession.get(entry.sessionId);
  if (!group) return;
  group.delete(entry);
  if (group.size === 0) bySession.delete(entry.sessionId);
}

/** Reap every child owned by one session (session delete / app quit). */
export function killSessionProcesses(sessionId: string): void {
  const group = bySession.get(sessionId);
  if (!group) return;
  for (const entry of [...group]) killTree(entry.child.pid, entry.processGroup);
}

/** Reap every tracked child (app quit). */
export function killAllProcesses(): void {
  for (const group of bySession.values()) {
    for (const entry of group) killTree(entry.child.pid, entry.processGroup);
  }
}

/** Reap one child's process tree (an aborted turn's foreground command). */
export function killProcess(child: ChildProcess): void {
  killTree(child.pid, byChild.get(child)?.processGroup ?? false);
}

/** Number of live tracked children (diagnostics / tests). */
export function trackedProcessCount(): number {
  return byChild.size;
}

/**
 * Reap tracked children when the host is terminated. Children are spawned in
 * their own process group, so they no longer die with the terminal's group;
 * a host that does not call {@link killAllProcesses} on quit (the CLI) needs
 * this to avoid leaving them behind.
 */
export function installProcessCleanup(): void {
  ensureExitHook();
  if (signalHooksInstalled) return;
  signalHooksInstalled = true;
  process.once('SIGHUP', () => {
    killAllSync();
    process.exit(129);
  });
  process.once('SIGTERM', () => {
    killAllSync();
    process.exit(143);
  });
}
