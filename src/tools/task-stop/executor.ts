import type { ToolExecutor } from '../types.js';
import { getTask, updateTask } from '../../tasks/task-tracker.js';
import { getSubAgentRegistry } from '../../agents/agent-spawn/registry-ref.js';

export const execute: ToolExecutor = async (input, _opts) => {
  const taskId = input.task_id as string;

  if (!taskId) {
    return { content: 'Error: task_id is required', isError: true };
  }

  // Check in-memory tracker
  const tracked = getTask(taskId);
  if (tracked) {
    if (tracked.status !== 'running') {
      return {
        content: `Task ${taskId} is not running (status: ${tracked.status})`,
        isError: true,
      };
    }

    if (tracked.type === 'bash' && tracked.process) {
      tracked.process.kill('SIGTERM');
      // Give it a moment, then SIGKILL if still alive
      setTimeout(() => {
        if (tracked.process && !tracked.process.killed) {
          tracked.process.kill('SIGKILL');
        }
      }, 2000);
    }

    if (tracked.abortController) {
      tracked.abortController.abort();
    }

    updateTask(taskId, {
      status: 'stopped',
      finishedAt: Date.now(),
    });

    return {
      content: `Task ${taskId} (${tracked.type}) stopped.`,
      isError: false,
      metadata: { task_id: taskId, task_type: tracked.type },
    };
  }

  // Check SubAgentRegistry
  const registry = getSubAgentRegistry();
  const subAgent = registry?.get(taskId);

  if (subAgent) {
    if (subAgent.status !== 'running') {
      return {
        content: `Agent ${taskId} is not running (status: ${subAgent.status})`,
        isError: true,
      };
    }

    subAgent.abortController.abort();
    registry?.update(taskId, { status: 'stopped', finishedAt: Date.now() });

    return {
      content: `Sub-agent ${taskId} (${subAgent.agentType}) stopped.`,
      isError: false,
      metadata: { task_id: taskId, task_type: 'agent' },
    };
  }

  return {
    content: `No running task found with ID: ${taskId}`,
    isError: true,
  };
};
