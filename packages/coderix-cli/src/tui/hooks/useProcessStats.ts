import { useState, useEffect, useRef } from 'react';
import { execSync } from 'child_process';

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
 * On Windows we skip OS-level counting — wmic was removed in Win11 24H2,
 * and running external commands for a minor status-bar number isn't worth
 * the complexity.  In-process sub-agent counts are added separately by the
 * StatusBar caller.
 */
export function useProcessStats(intervalMs = 3000): ProcessStats {
  const pidRef = useRef(process.pid);
  const [stats, setStats] = useState<ProcessStats>(() => ({
    memory: process.memoryUsage().rss,
    osProcessCount: countDescendants(pidRef.current),
  }));

  // Track previous values so we only update state when something changes
  // beyond the noise threshold.  This avoids unnecessary React → Ink
  // re-renders that cause visible flicker on Windows terminals where ANSI
  // redraw is slower.
  const prevRef = useRef(stats);

  useEffect(() => {
    const id = setInterval(() => {
      const next: ProcessStats = {
        memory: process.memoryUsage().rss,
        osProcessCount: countDescendants(pidRef.current),
      };
      // Skip update unless memory changed by ≥ threshold or process count changed
      if (
        Math.abs(next.memory - prevRef.current.memory) < MEMORY_CHANGE_THRESHOLD &&
        next.osProcessCount === prevRef.current.osProcessCount
      ) {
        return;
      }
      prevRef.current = next;
      setStats(next);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return stats;
}

function countDescendants(rootPid: number): number {
  // OS-level process counting is Unix-only.  On Windows we return 0 —
  // in-process sub-agent counts are added separately by the StatusBar.
  if (process.platform === 'win32') return 0;

  try {
    return countDescendantsUnix(rootPid);
  } catch {
    return 0;
  }
}

/** Unix: walk the process tree via `ps -eo`. */
function countDescendantsUnix(rootPid: number): number {
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

  return bfsCount(rootPid, children);
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
