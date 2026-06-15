/**
 * Lightweight in-memory tracker for background tasks.
 *
 * Both the bash tool (run_in_background) and agent-spawn (background)
 * register tasks here so TaskOutput / TaskStop can query and control them.
 */

import type { ChildProcess } from 'node:child_process';

export type TrackedTaskType = 'bash' | 'agent';

export interface TrackedTask {
  id: string;
  type: TrackedTaskType;
  status: 'running' | 'done' | 'error' | 'stopped';
  description: string;
  /** File path where task output is written (if available). */
  outputPath?: string;
  /** For bash tasks: the child process handle for stop/kill. */
  process?: ChildProcess;
  /** For agent tasks: the abort controller for cancellation. */
  abortController?: AbortController;
  createdAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

const tasks = new Map<string, TrackedTask>();

export function registerTask(task: TrackedTask): void {
  tasks.set(task.id, task);
}

export function getTask(id: string): TrackedTask | undefined {
  return tasks.get(id);
}

export function updateTask(id: string, patch: Partial<TrackedTask>): void {
  const existing = tasks.get(id);
  if (existing) Object.assign(existing, patch);
}

export function listTasks(): TrackedTask[] {
  return Array.from(tasks.values());
}

export function unregisterTask(id: string): void {
  tasks.delete(id);
}
