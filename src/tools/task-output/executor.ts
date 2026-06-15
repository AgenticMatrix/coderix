import type { ToolExecutor } from '../types.js';
import { getTask } from '../../tasks/task-tracker.js';
import { readFile, access } from 'node:fs/promises';
import { getSubAgentRegistry } from '../../agents/agent-spawn/registry-ref.js';

const POLL_INTERVAL = 200;

async function readOutputFile(path: string, maxLength: number): Promise<string> {
  try {
    await access(path);
    const content = await readFile(path, 'utf-8');
    if (content.length > maxLength) {
      return content.slice(content.length - maxLength) + '\n...(truncated)';
    }
    return content;
  } catch {
    return '';
  }
}

export const execute: ToolExecutor = async (input, _opts) => {
  const taskId = input.task_id as string;
  const block = (input.block as boolean) ?? true;
  const timeout = Math.min((input.timeout as number) ?? 30000, 600000);

  if (!taskId) {
    return { content: 'Error: task_id is required', isError: true };
  }

  // Check in-memory tracker first
  const tracked = getTask(taskId);

  // If task ID looks like a sub-agent ID, check SubAgentRegistry
  const registry = getSubAgentRegistry();
  const subAgent = registry?.get(taskId);

  if (!tracked && !subAgent) {
    return {
      content: `No task found with ID: ${taskId}. Background task IDs are shown in task tool results (e.g. "bash-12345" for bash, or agent IDs for spawned agents).`,
      isError: true,
      metadata: { taskId, block },
    };
  }

  if (!block) {
    // Non-blocking: return current status immediately
    if (tracked) {
      let outputText = '';
      if (tracked.outputPath) {
        outputText = await readOutputFile(tracked.outputPath, 50000);
      }
      return {
        content: JSON.stringify({
          task_id: tracked.id,
          task_type: tracked.type,
          status: tracked.status,
          description: tracked.description,
          result: tracked.result ?? null,
          error: tracked.error ?? null,
        }, null, 2),
        isError: tracked.status === 'error',
        metadata: {
          taskId: tracked.id,
          block,
          description: tracked.description,
          status: tracked.status,
          taskType: tracked.type,
          outputLines: outputText || undefined,
        },
      };
    }

    if (subAgent) {
      return {
        content: JSON.stringify({
          task_id: subAgent.id,
          task_type: 'agent',
          status: subAgent.status,
          description: subAgent.prompt.slice(0, 200),
          turns: subAgent.turnCount,
          tools: subAgent.toolCount,
        }, null, 2),
        isError: subAgent.status === 'error',
        metadata: {
          taskId: subAgent.id,
          block,
          description: subAgent.prompt.slice(0, 200),
          status: subAgent.status,
          taskType: 'agent',
          turns: subAgent.turnCount,
          tools: subAgent.toolCount,
        },
      };
    }
  }

  // Blocking: wait for completion
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const current = getTask(taskId);
    const currentAgent = registry?.get(taskId);

    if (current && current.status !== 'running') {
      let output = '';

      // Try reading from output path if available
      if (current.outputPath) {
        output = await readOutputFile(current.outputPath, 50000);
      }

      return {
        content: JSON.stringify({
          task_id: current.id,
          task_type: current.type,
          status: current.status,
          description: current.description,
          result: current.result || output || null,
          error: current.error ?? null,
          finished: true,
        }, null, 2),
        isError: current.status === 'error',
        metadata: {
          taskId: current.id,
          block,
          description: current.description,
          status: current.status,
          taskType: current.type,
          outputLines: current.result || output || undefined,
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
          block,
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

  // Timeout
  const final = getTask(taskId);
  const finalAgent = registry?.get(taskId);

  if (final) {
    return {
      content: JSON.stringify({
        task_id: final.id,
        task_type: final.type,
        status: 'timeout',
        description: final.description,
        result: null,
      }, null, 2),
      isError: false,
      metadata: {
        taskId: final.id,
        block,
        description: final.description,
        status: 'timeout',
        taskType: final.type,
      },
    };
  }

  if (finalAgent) {
    return {
      content: JSON.stringify({
        task_id: finalAgent.id,
        task_type: 'agent',
        status: 'timeout',
        description: finalAgent.prompt.slice(0, 200),
      }, null, 2),
      isError: false,
      metadata: {
        taskId: finalAgent.id,
        block,
        description: finalAgent.prompt.slice(0, 200),
        status: 'timeout',
        taskType: 'agent',
      },
    };
  }

  return { content: 'Task timed out and is no longer available', isError: true, metadata: { taskId, block } };
};
