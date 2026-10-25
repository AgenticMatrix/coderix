import { describe, it, expect } from 'vitest';
import { execute as bash } from '../../../packages/coderix-core/src/tools/bash/executor.js';
import { execute as taskOutput } from '../../../packages/coderix-core/src/tools/task-output/executor.js';
import { execute as taskStop } from '../../../packages/coderix-core/src/tools/task-stop/executor.js';
import { unregisterTask, listTasks, getTask } from '../../../packages/coderix-core/src/tasks/task-tracker.js';

function opts(maxOutput = 50_000) {
  return {
    cwd: process.cwd(),
    bashTimeout: 120_000,
    maxOutput,
    sessionId: 'output-test',
    allowMutation: true,
    emitToolRequest: async () => {},
  } as never;
}

describe('bash output retention', () => {
  it('keeps the head and the newest tail when output exceeds the cap', async () => {
    // ~2.4 KB of output against a 400 character cap.
    const result = await bash(
      { command: "seq 1 400 | sed 's/$/ XX/'", description: 'overflow' },
      opts(400),
    );

    expect(result.content.indexOf('1 XX')).toBe(0);
    expect(result.content).toContain('[output truncated]');
    expect(result.content).toContain('400 XX');
    expect(result.content.length).toBeLessThan(600);
  });

  it('does not mark output that fits the cap', async () => {
    const result = await bash({ command: 'echo hello', description: 'small' }, opts(400));
    expect(result.content.trim()).toBe('hello');
    expect(result.content).not.toContain('truncated');
  });

  it('bounds output even when the cap is smaller than the marker', async () => {
    const result = await bash(
      { command: "seq 1 400 | sed 's/$/ XX/'", description: 'tiny' },
      opts(25),
    );
    expect(result.content.length).toBeLessThanOrEqual(25);
    expect(result.content).toContain('400');
  });
});

describe('TaskOutput while the task runs', () => {
  it('returns the output captured so far instead of a bare timeout', async () => {
    const started = await bash(
      { command: 'echo started; sleep 20', description: 'live', run_in_background: true },
      opts(),
    );
    const taskId = (started.metadata as { task_id?: string })?.task_id;
    expect(taskId).toBeTruthy();

    try {
      const snapshot = await taskOutput({ task_id: taskId, timeout: 500 }, opts());
      const payload = JSON.parse(snapshot.content) as { status: string; result: string | null };
      expect(payload.status).toBe('running');
      expect(payload.result).toContain('started');
      expect(snapshot.isError).toBe(false);
    } finally {
      await taskStop({ task_id: taskId }, opts());
      // The killed process exits non-zero; the record must stay `stopped`
      // rather than being rewritten as an error by the close handler.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(getTask(taskId)?.status).toBe('stopped');
      for (const task of listTasks()) unregisterTask(task.id);
    }
  }, 30_000);
});
