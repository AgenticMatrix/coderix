/**
 * Tests for process-registry.ts — bash child tracking and session-scoped reaping.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  registerProcess,
  unregisterProcess,
  killSessionProcesses,
  killAllProcesses,
  trackedProcessCount,
} from '../../../packages/coderix-core/src/tools/bash/process-registry.js';

const POSIX_GROUP = process.platform !== 'win32';
const spawned: ChildProcess[] = [];

function spawnLongLived(): ChildProcess {
  // `shell: true` mirrors the bash tool: the real process is a grandchild.
  const child = spawn('sleep 30', {
    shell: true,
    detached: POSIX_GROUP,
    stdio: 'ignore',
  });
  spawned.push(child);
  return child;
}

function register(child: ChildProcess, sessionId: string): void {
  registerProcess(child, { sessionId, processGroup: POSIX_GROUP });
}

function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('process did not exit in time')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  killAllProcesses();
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  spawned.length = 0;
});

describe('process registry', () => {
  it('tracks a registered child and drops it on exit', async () => {
    const child = spawnLongLived();
    register(child, 's1');
    expect(trackedProcessCount()).toBe(1);

    child.kill('SIGKILL');
    await waitForExit(child);
    // 'exit' unregisters asynchronously via the child's event emitter.
    await new Promise((r) => setTimeout(r, 50));
    expect(trackedProcessCount()).toBe(0);
  });

  it('kills the named session only', async () => {
    const mine = spawnLongLived();
    const other = spawnLongLived();
    register(mine, 'mine');
    register(other, 'other');

    killSessionProcesses('mine');
    await waitForExit(mine);
    expect(other.exitCode).toBeNull();

    killSessionProcesses('other');
    await waitForExit(other);
    expect(trackedProcessCount()).toBe(0);
  });

  it('unregister is idempotent', () => {
    const child = spawnLongLived();
    register(child, 's3');
    unregisterProcess(child);
    unregisterProcess(child);
    expect(trackedProcessCount()).toBe(0);
  });

  it.runIf(POSIX_GROUP)('kills grandchildren that outlive the shell', async () => {
    // The shell spawns one background child, prints its pid, then waits.
    const child = spawn('sleep 30 & echo $!; wait', {
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    spawned.push(child);
    register(child, 'tree');

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grandchild pid not reported')), 5000);
      child.stdout?.once('data', (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(Number(chunk.toString().trim()));
      });
    });
    expect(isAlive(grandchildPid)).toBe(true);

    // The shell ignores SIGTERM here only in the sense that it exits first;
    // the grandchild is in the same process group and must die with it.
    killSessionProcesses('tree');
    await waitForExit(child);
    await new Promise((r) => setTimeout(r, 300));
    expect(isAlive(grandchildPid)).toBe(false);
  });
});
