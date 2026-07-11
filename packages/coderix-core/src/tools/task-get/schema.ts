import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskGet',
  description:
    'Retrieve full details for a single task, or query sub-agent status.\n\n## When to Use (Task Query)\n\n- Before starting work on a task — verify its `blockedBy` list is empty.\n- To understand what a task blocks and what blocks it.\n- After being assigned a task to get the complete requirements.\n\n## Output\n\nReturns the full task object:\n- **subject**: Task title.\n- **description**: Detailed requirements and context.\n- **status**: `pending`, `in_progress`, or `completed`.\n- **owner**: Agent ID if assigned.\n- **blocks**: Tasks waiting on this one to complete.\n- **blockedBy**: Tasks that must complete before this one can start.\n- **metadata**: Arbitrary key-value data attached to the task.\n\nAlways verify `blockedBy` is empty before beginning work on a task.\n\n## Sub-agent Query\n\nUse `agent_id` to query a specific sub-agent spawned via the Agent tool, or `list_all: true` to list all sub-agents and their statuses.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to retrieve full details for.',
      },
      agent_id: {
        type: 'string',
        description: 'Query a sub-agent by its ID (returned by the Agent tool).',
      },
      list_all: {
        type: 'boolean',
        description: 'Set to true to list all sub-agents and their statuses.',
      },
    },
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};
