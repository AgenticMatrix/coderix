/**
 * Lightweight in-memory tracker for background tasks.
 *
 * Both the bash tool (run_in_background) and Agent (background)
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

// ── Background task notification queue ──────────────────────

const _pendingNotifications: string[] = [];

/**
 * Called when a background bash task completes (process exits).
 * Builds a structured <task-notification> that will be injected
 * into the conversation on the next tool-execution cycle.
 */
export function notifyTaskCompletion(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task) return;

  const elapsed = ((task.finishedAt ?? Date.now()) - task.createdAt) / 1000;
  const status = task.status === 'error' ? 'failed' : task.status === 'stopped' ? 'killed' : 'completed';

  const lines: string[] = [
    '<task-notification>',
    `  <task_id>${task.id}</task_id>`,
    `  <task_type>${task.type}</task_type>`,
    `  <status>${status}</status>`,
    `  <description>${task.description}</description>`,
    `  <elapsed>${elapsed.toFixed(1)}s</elapsed>`,
  ];

  if (task.error) {
    lines.push(`  <error>${task.error}</error>`);
  }

  if (task.result) {
    lines.push(`  <result>${task.result.slice(0, 2000)}</result>`);
  }

  lines.push('</task-notification>');
  _pendingNotifications.push(lines.join('\n'));
}

/** Drain and return all pending background task notifications. */
export function drainTaskNotifications(): string[] {
  if (_pendingNotifications.length === 0) return [];
  const drained = _pendingNotifications.splice(0);
  return drained;
}
