import type { ToolExecutor } from '../types.js';
import { getTask } from '../../tasks/task-tracker.js';
import { getSubAgentRegistry } from '../../agents/agent-spawn/registry-ref.js';

const POLL_INTERVAL = 200;

export const execute: ToolExecutor = async (input, _opts) => {
  const taskId = input.task_id as string;
  const timeout = Math.min((input.timeout as number) ?? 15000, 60000);

  if (!taskId) {
    return { content: 'Error: task_id is required', isError: true };
  }

  // Resolve task ID — try exact match, then bash- prefix fallback
  const resolveTask = (id: string) => {
    let t = getTask(id);
    if (!t) t = getTask(`bash-${id}`);
    return t;
  };

  const tracked = resolveTask(taskId);

  // If task ID looks like a sub-agent ID, check SubAgentRegistry
  const registry = getSubAgentRegistry();
  const subAgent = registry?.get(taskId);

  if (!tracked && !subAgent) {
    return {
      content: `No task found with ID: ${taskId}. Background task IDs are shown in task tool results (e.g. "bash-12345" for bash, or agent IDs for spawned agents).`,
      isError: true,
      metadata: { taskId },
    };
  }

  // Blocking: wait for completion
  const deadline = Date.now() + timeout;
  const resolvedId = tracked?.id ?? (subAgent?.id ?? taskId);

  while (Date.now() < deadline) {
    const current = resolvedId ? getTask(resolvedId) : undefined;
    const currentAgent = registry?.get(resolvedId);

    if (current && current.status !== 'running') {
      return {
        content: JSON.stringify({
          task_id: current.id,
          task_type: current.type,
          status: current.status,
          description: current.description,
          result: current.result ?? null,
          error: current.error ?? null,
          finished: true,
        }, null, 2),
        isError: current.status === 'error',
        metadata: {
          taskId: current.id,
          description: current.description,
          status: current.status,
          taskType: current.type,
          outputLines: current.result ?? undefined,
        },
      };
    }

    if (currentAgent && currentAgent.status !== 'running') {
      return {
        content: JSON.stringify({
          task_id: currentAgent.id,
          task_type: 'agent',
          status: currentAgent.status,
          description: currentAgent.prompt.slice(0, 500),
          turns: currentAgent.turnCount,
          tools: currentAgent.toolCount,
          result: currentAgent.result ?? null,
          error: currentAgent.error ?? null,
          finished: true,
        }, null, 2),
        isError: currentAgent.status === 'error',
        metadata: {
          taskId: currentAgent.id,
          description: currentAgent.prompt.slice(0, 200),
          status: currentAgent.status,
          taskType: 'agent',
          turns: currentAgent.turnCount,
          tools: currentAgent.toolCount,
        },
      };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  // Wait expired while the task was still running: hand back what it has
  // produced so far instead of pretending the task itself timed out.
  const final = resolvedId ? getTask(resolvedId) : undefined;
  const finalAgent = registry?.get(resolvedId);

  if (final) {
    const live = final.readOutput?.();
    const partial = [live?.stdout, live?.stderr].filter(Boolean).join('\n').trim();
    return {
      content: JSON.stringify({
        task_id: final.id,
        task_type: final.type,
        status: 'running',
        description: final.description,
        result: partial || null,
        note: 'Task is still running; result holds the output captured so far.',
      }, null, 2),
      isError: false,
      metadata: {
        taskId: final.id,
        description: final.description,
        status: 'running',
        taskType: final.type,
        outputLines: partial || undefined,
      },
    };
  }

  if (finalAgent) {
    return {
      content: JSON.stringify({
        task_id: finalAgent.id,
        task_type: 'agent',
        status: 'running',
        description: finalAgent.prompt.slice(0, 200),
        note: 'Agent is still running; query again for its result.',
      }, null, 2),
      isError: false,
      metadata: {
        taskId: finalAgent.id,
        description: finalAgent.prompt.slice(0, 200),
        status: 'running',
        taskType: 'agent',
      },
    };
  }

  return { content: 'Task timed out and is no longer available', isError: true, metadata: { taskId } };
};
