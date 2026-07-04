import { useState, useEffect, useRef } from 'react';
import { execSync } from 'child_process';

export interface ProcessStats {
  /** Total RSS memory of the main Node.js process in bytes (includes all in-process sub-agents). */
  memory: number;
  /** Number of OS-level child processes (bash tools, etc.). */
  osProcessCount: number;
}

/**
 * Poll process metrics every `intervalMs`.
 *
 * Memory comes from process.memoryUsage().rss — it captures the entire
 * V8 heap including all in-process sub-agents and tool executors.
 *
 * OS process count comes from counting descendants via ps — these are
 * child processes spawned by tools (bash, etc.).  In-process sub-agents
 * are NOT visible to ps, so the caller must add them separately.
 */
export function useProcessStats(intervalMs = 3000): ProcessStats {
  const pidRef = useRef(process.pid);
  const [stats, setStats] = useState<ProcessStats>(() => ({
    memory: process.memoryUsage().rss,
    osProcessCount: countDescendants(pidRef.current),
  }));

  useEffect(() => {
    const id = setInterval(() => {
      setStats({
        memory: process.memoryUsage().rss,
        osProcessCount: countDescendants(pidRef.current),
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return stats;
}

function countDescendants(rootPid: number): number {
  try {
    // comm column lets us filter out the ps/sh processes spawned by execSync itself
    const output = execSync('ps -eo pid,ppid,comm', {
      timeout: 1000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });

    const children = new Map<number, number[]>();

    for (const line of output.trim().split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('PID')) continue;

      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) continue;

      const cPid = parseInt(parts[0], 10);
      const pPid = parseInt(parts[1], 10);
      const comm = parts[2];

      if (isNaN(cPid) || isNaN(pPid)) continue;

      // Ignore the ps and sh processes spawned by execSync itself
      if (comm === 'ps' || comm === 'sh') continue;

      if (!children.has(pPid)) {
        children.set(pPid, []);
      }
      children.get(pPid)!.push(cPid);
    }

    // BFS to count all descendants
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
  } catch {
    return 0;
  }
}
