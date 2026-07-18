/**
 * Coordinator mode agent definitions.
 *
 * When coordinator mode is active, the main agent acts as an orchestrator
 * that delegates work to worker sub-agents. A single versatile 'worker'
 * agent type handles all execution — the coordinator decides what model
 * and prompt to give each worker based on the task.
 */

import type { BuiltInAgentDefinition } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Coordinator (the orchestrator itself)
// ---------------------------------------------------------------------------

export const coordinatorAgent: BuiltInAgentDefinition = {
  agentType: 'coordinator',
  source: 'built-in',
  baseDir: 'built-in',
  whenToUse:
    'Orchestrates a team of workers. Analyzes tasks, decomposes into parallel subtasks, delegates via Agent, synthesizes results. Does NOT write code directly.',
  tools: [
    'Agent',
    'SendMessage',
    'TaskStop',
    'TaskGet',
    'TeamCreate',
    'TeamDelete',
    'TaskCreate',
    'TaskUpdate',
    'TaskList',
    'Sleep',
  ],
  disallowedTools: [],
  model: 'sonnet',
  maxTurns: 30,
  contextBudget: 150_000,
  color: 'purple',
  getSystemPrompt: () => '',
};

// ---------------------------------------------------------------------------
// Worker — the single general-purpose execution agent
// ---------------------------------------------------------------------------

export const workerAgent: BuiltInAgentDefinition = {
  agentType: 'worker',
  source: 'built-in',
  baseDir: 'built-in',
  whenToUse:
    'General-purpose worker agent. Handles implementation, testing, code review, and research. Use for any delegated subtask.',
  tools: '*',
  model: 'sonnet',
  maxTurns: 25,
  contextBudget: 120_000,
  color: 'green',
  getSystemPrompt: () => [
    'You are a worker agent spawned by a team leader to complete an assigned task.',
    '',
    'Rules:',
    '- Complete only the task you were given. Do not expand scope.',
    '- Do not spawn sub-agents. You are a leaf node.',
    '- Do not ask the user questions. Work autonomously.',
    '- Report results concisely: what you did, what you found, what changed.',
    '- Include absolute file paths and line numbers where relevant.',
    '- If you hit a blocker you cannot resolve, report it clearly and stop.',
    '',
    'When communicating with your leader, use SendMessage(to: "leader", text: "...").',
    'Your final response is your deliverable. Make it self-contained and actionable.',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/** All coordinator mode agent definitions. */
export function getCoordinatorAgents(): BuiltInAgentDefinition[] {
  return [coordinatorAgent, workerAgent];
}
