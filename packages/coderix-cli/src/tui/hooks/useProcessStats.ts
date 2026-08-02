import { useState, useEffect, useRef } from 'react';
import { exec } from 'child_process';

export interface ProcessStats {
  /** Total RSS memory of the main Node.js process in bytes (includes all in-process sub-agents). */
  memory: number;
  /** Number of OS-level child processes (bash tools, etc.). */
  osProcessCount: number;
}

/** Minimum RSS change (bytes) before triggering a state update.
 *  RSS fluctuates by KBs constantly; we only care about MB-scale changes.
 *  This avoids spurious Ink re-renders that cause visible flicker on Windows. */
const MEMORY_CHANGE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

/**
 * Poll process metrics every `intervalMs`.
 *
 * Memory comes from process.memoryUsage().rss — it captures the entire
 * V8 heap including all in-process sub-agents and tool executors.
 *
 * OS process count comes from counting descendants via `ps -eo` (Unix only).
 * Uses async exec to avoid blocking the event loop — execSync was causing
 * visible UI stutter every 3s during idle.
 */
export function useProcessStats(intervalMs = 10000): ProcessStats {
  const pidRef = useRef(process.pid);
  const [stats, setStats] = useState<ProcessStats>(() => ({
    memory: process.memoryUsage().rss,
    osProcessCount: 0, // async load on first poll
  }));

  const prevRef = useRef(stats);

  useEffect(() => {
    let active = true;

    async function poll() {
      if (!active) return;

      const memory = process.memoryUsage().rss;
      let osProcessCount = prevRef.current.osProcessCount;

      if (process.platform !== 'win32') {
        try {
          osProcessCount = await countDescendantsAsync(pidRef.current);
        } catch {
          // Keep previous count on error
        }
      }

      if (!active) return;

      const next: ProcessStats = { memory, osProcessCount };
      if (
        Math.abs(next.memory - prevRef.current.memory) < MEMORY_CHANGE_THRESHOLD &&
        next.osProcessCount === prevRef.current.osProcessCount
      ) {
        return;
      }
      prevRef.current = next;
      setStats(next);
    }

    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return stats;
}

/** Unix: walk the process tree via `ps -eo` asynchronously. */
function countDescendantsAsync(rootPid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    exec('ps -eo pid,ppid,comm', { timeout: 2000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }

      const children = new Map<number, number[]>();

      for (const line of stdout.trim().split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('PID')) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 3) continue;

        const cPid = parseInt(parts[0], 10);
        const pPid = parseInt(parts[1], 10);
        const comm = parts[2];

        if (isNaN(cPid) || isNaN(pPid)) continue;
        if (comm === 'ps' || comm === 'sh') continue;

        if (!children.has(pPid)) {
          children.set(pPid, []);
        }
        children.get(pPid)!.push(cPid);
      }

      resolve(bfsCount(rootPid, children));
    });
  });
}

/** BFS to count all descendants. */
function bfsCount(rootPid: number, children: Map<number, number[]>): number {
  let count = 0;
  const queue = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      count++;
      queue.push(child);
    }
  }

  return count;
}
