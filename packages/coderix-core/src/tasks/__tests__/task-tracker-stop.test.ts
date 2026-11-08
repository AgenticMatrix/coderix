import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `stopTasksSince` decides which background work a stop reaps. The dangerous
 * failure mode is over-reach: a dev server started by an earlier turn must keep
 * running, so the test pins the boundary (by start time and by session).
 */

vi.mock('../../tools/bash/process-registry.js', () => ({
  killProcess: vi.fn(),
}));

import { killProcess } from '../../tools/bash/process-registry.js';
import {
  registerTask,
  stopTasksSince,
  getTask,
  listTasks,
} from '../task-tracker.js';
import type { TrackedTask } from '../task-tracker.js';

const killProcessMock = vi.mocked(killProcess);

let counter = 0;

function makeTask(overrides: Partial<TrackedTask> = {}): TrackedTask {
  counter += 1;
  return {
    id: `tracked-${counter}`,
    type: 'bash',
    status: 'running',
    description: 'sleep 999',
    createdAt: 1_000,
    ...overrides,
  } as TrackedTask;
}

describe('stopTasksSince', () => {
  beforeEach(() => {
    // The tracker is process-global; settle every record between cases so one
    // test's task cannot leak into the next one's assertions.
    for (const task of listTasks()) {
      task.status = 'done';
    }
    killProcessMock.mockClear();
  });

  it('stops a task created during the turn', () => {
    const task = makeTask({ createdAt: 2_000, sessionId: 's1' });
    registerTask(task);

    const stopped = stopTasksSince(1_500, 's1');

    expect(stopped).toEqual([task.id]);
    expect(getTask(task.id)!.status).toBe('stopped');
    expect(getTask(task.id)!.finishedAt).toBeTypeOf('number');
  });

  it('leaves an earlier turn\u2019s task running', () => {
    const earlier = makeTask({ createdAt: 500, sessionId: 's1' });
    registerTask(earlier);

    const stopped = stopTasksSince(1_500, 's1');

    expect(stopped).toEqual([]);
    expect(getTask(earlier.id)!.status).toBe('running');
    expect(killProcessMock).not.toHaveBeenCalled();
  });

  it('ignores tasks belonging to another session', () => {
    const other = makeTask({ createdAt: 2_000, sessionId: 's2' });
    registerTask(other);

    const stopped = stopTasksSince(1_500, 's1');

    expect(stopped).toEqual([]);
    expect(getTask(other.id)!.status).toBe('running');
  });

  it('kills the child process of a bash task and aborts an agent task', () => {
    const child = {} as TrackedTask['process'];
    const bash = makeTask({ createdAt: 2_000, sessionId: 's1', process: child });
    const abortController = new AbortController();
    const agent = makeTask({
      createdAt: 2_000,
      sessionId: 's1',
      type: 'agent',
      process: undefined,
      abortController,
    });
    registerTask(bash);
    registerTask(agent);

    stopTasksSince(1_500, 's1');

    expect(killProcessMock).toHaveBeenCalledTimes(1);
    expect(killProcessMock).toHaveBeenCalledWith(child);
    expect(abortController.signal.aborted).toBe(true);
    expect(getTask(agent.id)!.status).toBe('stopped');
  });

  it('does not touch tasks that already settled', () => {
    const done = makeTask({ createdAt: 2_000, sessionId: 's1', status: 'done' });
    registerTask(done);

    expect(stopTasksSince(1_500, 's1')).toEqual([]);
    expect(killProcessMock).not.toHaveBeenCalled();
  });
});