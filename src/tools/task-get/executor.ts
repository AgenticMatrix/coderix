import { getTask } from '../../tasks/store.js';
import { getSubAgentRegistry } from '../../agents/agent-spawn/registry-ref.js';
import type { ToolExecutor } from '../types.js';

export const execute: ToolExecutor = async (input, options) => {
  // ── Sub-agent query (from former agent-read) ──────────────────────
  const agentId = input.agent_id as string | undefined;
  const listAll = input.list_all as boolean | undefined;

  if (listAll || agentId) {
    const registry = getSubAgentRegistry() || options.agentSpawn?.subAgentRegistry;
    if (!registry) {
      return { content: 'No active sub-agent session.', isError: true };
    }

    if (listAll) {
      const agents = registry.list();
      if (agents.length === 0) {
        return { content: 'No sub-agents found.', isError: false };
      }

      const lines = agents.map(a => {
        const elapsed = a.finishedAt
          ? `${((a.finishedAt - a.createdAt) / 1000).toFixed(1)}s`
          : `${((Date.now() - a.createdAt) / 1000).toFixed(1)}s elapsed`;
        return [
          `${a.id} (${a.agentType}) — ${a.status}`,
          `  Turns: ${a.turnCount} | Messages: ${a.messageCount} | Tools: ${a.toolCount} | ${elapsed}`,
          a.error ? `  Error: ${a.error}` : '',
          a.result && a.status === 'done' ? `  Result: ${a.result.slice(0, 200)}...` : '',
        ].filter(Boolean).join('\n');
      });

      return { content: `Sub-agents (${agents.length}):\n\n${lines.join('\n\n')}`, isError: false };
    }

    if (agentId) {
      const agent = registry.get(agentId);
      if (!agent) {
        return { content: `Sub-agent not found: ${agentId}`, isError: true };
      }

      const elapsed = agent.finishedAt
        ? `${((agent.finishedAt - agent.createdAt) / 1000).toFixed(1)}s`
        : `${((Date.now() - agent.createdAt) / 1000).toFixed(1)}s elapsed`;

      const content = [
        `Sub-agent: ${agent.id} (${agent.agentType})`,
        `Status: ${agent.status} | ${elapsed}`,
        `Turns: ${agent.turnCount} | Messages: ${agent.messageCount} | Tools: ${agent.toolCount}`,
        `Prompt: ${agent.prompt.slice(0, 200)}`,
        '',
      ];

      if (agent.error) {
        content.push(`Error: ${agent.error}`);
      }

      if (agent.result) {
        content.push('Result:', agent.result);
      } else if (agent.status === 'running') {
        content.push('(Still running — no result yet)');
      }

      return { content: content.join('\n'), isError: false };
    }
  }

  // ── Todo task query ────────────────────────────────────────────────
  const taskId = input.taskId as string;
  if (!taskId) {
    return {
      content: 'Provide agent_id, list_all, or taskId.',
      isError: true,
    };
  }

  const task = await getTask(taskId);
  if (!task) return { content: `Error: Task #${taskId} not found`, isError: true };

  const details = [
    `Task #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
  ];
  if (task.activeForm) details.push(`Active form: ${task.activeForm}`);
  if (task.owner) details.push(`Owner: ${task.owner}`);
  if (task.blocks.length) details.push(`Blocks: ${task.blocks.join(', ')}`);
  if (task.blockedBy.length) details.push(`Blocked by: ${task.blockedBy.join(', ')}`);
  if (Object.keys(task.metadata).length) {
    details.push(`Metadata: ${JSON.stringify(task.metadata)}`);
  }

  return {
    content: details.join('\n'),
    isError: false,
    metadata: {
      taskId: task.id,
      subject: task.subject,
      description: task.description,
      activeForm: task.activeForm,
      status: task.status,
      owner: task.owner,
      blocks: task.blocks,
      blockedBy: task.blockedBy,
    },
  };
};
