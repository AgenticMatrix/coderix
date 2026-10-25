/**
 * End-to-end test for bash interrupt handling: aborting the turn's signal must
 * reap the spawned process tree, not just stop waiting for it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute } from '../../../packages/coderix-core/src/tools/bash/executor.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

function readPids(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

describe('bash executor abort', () => {
  it('kills the shell and its child when the signal aborts', async () => {
    const pidFile = join(tmpdir(), `coderix-abort-${process.pid}-${Date.now()}.pid`);
    const controller = new AbortController();

    // First line is the `sh -c` shell pid, second is the backgrounded sleep.
    const running = execute(
      { command: `echo $$ > ${pidFile}; sleep 30 & echo $! >> ${pidFile}; wait` },
      {
        cwd: process.cwd(),
        allowMutation: true,
        maxOutput: 1000,
        bashTimeout: 60_000,
        sessionId: 'abort-test',
        signal: controller.signal,
      },
    );

    const wrotePids = await waitFor(() => readPids(pidFile).length === 2);
    expect(wrotePids).toBe(true);

    const [shellPid, sleepPid] = readPids(pidFile);
    expect(isAlive(shellPid)).toBe(true);
    expect(isAlive(sleepPid)).toBe(true);

    controller.abort();
    const result = await running;
    expect(result.isError).toBe(true);

    // SIGTERM first, SIGKILL after a 1.5s grace period.
    const treeDied = await waitFor(
      () => !isAlive(shellPid) && !isAlive(sleepPid),
      6000,
    );
    rmSync(pidFile, { force: true });
    expect(treeDied).toBe(true);
  });
});
