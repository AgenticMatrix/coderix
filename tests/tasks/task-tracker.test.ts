/**
 * Tests for the in-memory background task tracker: terminal eviction and
 * notification delivery order.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerTask,
  updateTask,
  getTask,
  listTasks,
  unregisterTask,
  notifyTaskCompletion,
  drainTaskNotifications,
  type TrackedTask,
} from '../../packages/coderix-core/src/tasks/task-tracker.js';

function task(id: string, status: TrackedTask['status'] = 'running'): TrackedTask {
  return {
    id,
    type: 'bash',
    status,
    description: id,
    createdAt: Date.now(),
  };
}

beforeEach(() => {
  for (const t of listTasks()) unregisterTask(t.id);
  drainTaskNotifications();
});

describe('background task tracker', () => {
  it('keeps the 20 newest terminal tasks and drops older ones', () => {
    registerTask(task('running'));
    for (let i = 0; i < 25; i++) {
      registerTask(task(`t${i}`));
      updateTask(`t${i}`, { status: 'done', finishedAt: i });
    }

    const ids = listTasks().map((t) => t.id);
    expect(ids).toContain('running');
    expect(ids).not.toContain('t0');
    expect(ids).not.toContain('t4');
    expect(ids).toContain('t5');
    expect(ids).toContain('t24');
    expect(ids).toHaveLength(21);
  });

  it('never evicts a running task, however old', () => {
    registerTask(task('old-running'));
    for (let i = 0; i < 30; i++) {
      registerTask(task(`t${i}`));
      updateTask(`t${i}`, { status: 'done', finishedAt: i });
    }
    expect(getTask('old-running')).toBeDefined();
  });

  it('holds a finished task long enough to notify after eviction pressure', () => {
    registerTask(task('build'));
    updateTask('build', { status: 'done', finishedAt: Date.now(), result: 'ok' });
    notifyTaskCompletion('build');
    // A later registration prunes terminal records but must not eat the
    // notification that was already queued for this one.
    registerTask(task('next'));
    expect(drainTaskNotifications()).toHaveLength(1);
    expect(drainTaskNotifications()).toHaveLength(0);
  });

  it('keeps the task that just settled even when finishedAt ties', () => {
    const at = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(at);

    // 'victim' was inserted first, so a stable sort by finishedAt puts it
    // first among ties — it must still survive its own settlement.
    registerTask(task('victim'));
    for (let i = 0; i < 20; i++) registerTask(task(`t${i}`));
    for (let i = 0; i < 20; i++) updateTask(`t${i}`, { status: 'done', finishedAt: at });
    updateTask('victim', { status: 'done', finishedAt: at });

    expect(getTask('victim')).toBeDefined();
    expect(listTasks()).toHaveLength(20);
    notifyTaskCompletion('victim');
    expect(drainTaskNotifications()).toHaveLength(1);
    now.mockRestore();
  });

  it('exposes live output only while the task is tracked', () => {
    registerTask({ ...task('live'), readOutput: () => ({ stdout: 'partial', stderr: '' }) });
    expect(getTask('live')?.readOutput?.().stdout).toBe('partial');
  });
});
