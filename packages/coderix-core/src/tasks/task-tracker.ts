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
  /** For bash tasks: the child process handle for stop/kill. */
  process?: ChildProcess;
  /** For agent tasks: the abort controller for cancellation. */
  abortController?: AbortController;
  createdAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  /**
   * Live output reader for a running task. Never part of the emitted task
   * payload — it is a closure, not serialisable state.
   */
  readOutput?: () => { stdout: string; stderr: string };
}

const tasks = new Map<string, TrackedTask>();

/**
 * Terminal records kept after their notification is delivered. Each one holds
 * its full `result` plus the child handle, so an unbounded map grows for the
 * life of the process.
 */
const MAX_TERMINAL_TASKS = 20;

/**
 * Drop the oldest terminal records. Running tasks are never evicted, and
 * `keepId` protects the record whose settlement triggered this call — two
 * tasks finishing in the same millisecond share a `finishedAt`, so ordering
 * alone cannot tell which one is newest.
 */
function pruneTerminalTasks(keepId?: string): void {
  const terminal = [...tasks.values()].filter((task) => task.status !== 'running');
  let excess = terminal.length - MAX_TERMINAL_TASKS;
  if (excess <= 0) return;
  const candidates = terminal
    .filter((task) => task.id !== keepId)
    .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
  for (const task of candidates) {
    if (excess <= 0) break;
    tasks.delete(task.id);
    excess--;
  }
}

export function registerTask(task: TrackedTask): void {
  tasks.set(task.id, task);
  pruneTerminalTasks(task.id);
}

export function getTask(id: string): TrackedTask | undefined {
  return tasks.get(id);
}

export function updateTask(id: string, patch: Partial<TrackedTask>): void {
  const existing = tasks.get(id);
  if (!existing) return;
  Object.assign(existing, patch);
  // The task that just settled must survive this call long enough for its
  // notification to be built.
  if (existing.status !== 'running') pruneTerminalTasks(id);
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

/** Non-destructive check: are there pending notifications? */
export function hasPendingTaskNotifications(): boolean {
  return _pendingNotifications.length > 0;
}
