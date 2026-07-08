import treeKill from 'tree-kill';
import type { ToolExecutor } from '../types.js';
import { getTask, updateTask } from '../../tasks/task-tracker.js';
import { getSubAgentRegistry } from '../../agents/agent-spawn/registry-ref.js';

/**
 * Kill a process and its entire child tree.
 * On Unix: SIGTERM → (wait 2s) → SIGKILL via tree-kill.
 * On Windows: tree-kill wraps taskkill /F /T /PID.
 */
function killTaskProcess(pid: number): void {
  treeKill(pid, 'SIGTERM', (err) => {
    if (err) {
      // Fallback: try native kill
      try { process.kill(pid); } catch { /* already dead */ }
    }
  });
}

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
        metadata: { taskId, taskType: tracked.type, description: tracked.description },
      };
    }

    if (tracked.type === 'bash' && tracked.process) {
      const pid = tracked.process.pid!;
      killTaskProcess(pid);
      // Give it a moment, then force-kill if still alive
      setTimeout(() => {
        if (tracked.process && !tracked.process.killed) {
          treeKill(pid, 'SIGKILL', (err) => {
            if (err) {
              try { tracked.process?.kill(); } catch { /* already dead */ }
            }
          });
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
      metadata: { taskId, taskType: tracked.type, description: tracked.description },
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
        metadata: { taskId, taskType: 'agent', description: subAgent.prompt.slice(0, 100) },
      };
    }

    subAgent.abortController.abort();
    registry?.update(taskId, { status: 'stopped', finishedAt: Date.now() });

    return {
      content: `Sub-agent ${taskId} (${subAgent.agentType}) stopped.`,
      isError: false,
      metadata: { taskId, taskType: 'agent', description: subAgent.prompt.slice(0, 100) },
    };
  }

  return {
    content: `No running task found with ID: ${taskId}`,
    isError: true,
    metadata: { taskId },
  };
};
