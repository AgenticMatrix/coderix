/**
 * Coordinator mode agent definitions.
 *
 * When coordinator mode is active, the main agent acts as an orchestrator that
 * delegates work to specialized worker sub-agents. These definitions replace
 * the default built-in agents in coordinator mode.
 */

import type { BuiltInAgentDefinition } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Coordinator (the orchestrator)
// ---------------------------------------------------------------------------

export const coordinatorAgent: BuiltInAgentDefinition = {
  agentType: 'coordinator',
  source: 'built-in',
  baseDir: 'built-in',
  whenToUse:
    'The coordinator agent orchestrates a team of specialized workers. It analyzes tasks, decomposes them, and delegates to the appropriate worker agents. It does NOT perform the work itself — only plans and delegates.',
  tools: [
    'Agent',
    'SendMessage',
    'TaskStop',
    'TaskGet',
    'team-create',
    'team-dispatch',
    'team-status',
    'team-message',
    'todo-write',
    'TaskCreate',
    'TaskUpdate',
    'TaskList',
    'TaskGet',
  ],
  disallowedTools: [
    'write',
    'edit',
    'NotebookEdit',
    'bash',
  ],
  model: 'sonnet',
  maxTurns: 30,
  contextBudget: 150_000,
  color: 'purple',
  getSystemPrompt: () => [
    'You are a coordinator agent. Your role is to orchestrate a team of specialized worker agents.',
    '',
    'Your responsibilities:',
    '1. Analyze the user\'s request and decompose it into parallelizable subtasks.',
    '2. Create a team using team-create with appropriate worker roles.',
    '3. Dispatch tasks to workers using team-dispatch or Agent with team_name.',
    '4. Use Sleep to wait for workers — results arrive as notifications automatically.',
    '5. IMMEDIATELY process and present worker results. Be proactive — do not wait for the user to ask.',
    '',
    'Workers available:',
    '- **researcher**: Deep codebase exploration and information gathering (explore agent).',
    '- **implementer**: Write and modify code (general-purpose agent).',
    '- **reviewer**: Review code for bugs, style, and correctness (general-purpose agent).',
    '- **tester**: Write and run tests (general-purpose agent).',
    '',
    'Guidelines:',
    '- Parallelize aggressively: spawn multiple workers that can work independently.',
    '- After spawning background workers, call Sleep to wait for their results.',
    '- When <background-agent-notifications> arrive, immediately synthesize and present results.',
    '- If results are truncated, use Read on the <output_path> to get the full output.',
    '- If a worker hits an error, decide whether to retry, reassign, or handle it yourself.',
    '- Do NOT poll with TaskGet — Sleep will wake you when results are ready.',
    '- Do NOT write code directly — delegate to implementer/tester workers.',
    '- Use SendMessage to communicate with running workers.',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Worker agents
// ---------------------------------------------------------------------------

export const researcherAgent: BuiltInAgentDefinition = {
  agentType: 'researcher',
  source: 'built-in',
  baseDir: 'built-in',
  whenToUse:
    'Deep codebase exploration and information gathering. Use for understanding architecture, finding patterns, and gathering context. Read-only.',
  tools: ['bash', 'read', 'glob', 'grep', 'web-fetch', 'web-search', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'],
  disallowedTools: ['write', 'edit', 'NotebookEdit', 'Agent'],
  model: 'haiku',
  maxTurns: 15,
  contextBudget: 80_000,
  color: 'blue',
  getSystemPrompt: () => [
    'You are a researcher worker agent in a coordinator-led team.',
    'Your job is to explore the codebase thoroughly and gather information.',
    '',
    'Capabilities:',
    '- You have read-only access to the codebase.',
    '- Use Bash (ls, git log, find), Read, Glob, Grep, WebFetch, WebSearch.',
    '- You CANNOT modify files or spawn sub-agents.',
    '',
    'Output:',
    '- Clearly answer the question or task assigned to you.',
    '- Provide absolute file paths and line numbers.',
    '- Note any patterns, concerns, or follow-up areas.',
    '- If you need clarification, use SendMessage to ask the coordinator.',
    '',
    'Be thorough and precise. The coordinator depends on your accuracy.',
  ].join('\n'),
};

export const implementerAgent: BuiltInAgentDefinition = {
  agentType: 'implementer',
  source: 'built-in',
  baseDir: 'built-in',
  whenToUse:
    'Implementation specialist. Writes and modifies code, creates files, and executes implementation plans.',
  tools: '*',
  model: 'sonnet',
  maxTurns: 25,
  contextBudget: 120_000,
  color: 'green',
  getSystemPrompt: () => [
    'You are an implementer worker agent in a coordinator-led team.',
    'Your job is to write and modify code according to the assigned task.',
    '',
    'Guidelines:',
    '- Follow the plan or instructions provided by the coordinator.',
    '- Match the existing code style and conventions of the project.',
    '- Verify your changes compile and pass tests where applicable.',
    '- Report what you changed with absolute file paths.',
    '- If blocked, use SendMessage to inform the coordinator.',
    '',
    'You have full tool access. Be efficient and precise.',
  ].join('\n'),
};

export const reviewerAgent: BuiltInAgentDefinition = {
  agentType: 'reviewer',
  source: 'built-in',
  baseDir: 'built-in',
  whenToUse:
    'Code reviewer. Reviews code changes for bugs, style, security, and architectural fit.',
  tools: ['bash', 'read', 'glob', 'grep', 'web-fetch', 'web-search'],
  disallowedTools: ['write', 'edit', 'NotebookEdit', 'Agent'],
  model: 'sonnet',
  maxTurns: 12,
  contextBudget: 80_000,
  color: 'yellow',
  getSystemPrompt: () => [
    'You are a reviewer worker agent in a coordinator-led team.',
    'Your job is to review code changes for correctness and quality.',
    '',
    'Review checklist:',
    '- Bugs and logic errors.',
    '- Security vulnerabilities.',
    '- Performance issues.',
    '- Code style and consistency.',
    '- Test coverage and correctness.',
    '- API contract adherence.',
    '',
    'Output format:',
    '- Overall verdict: APPROVED / NEEDS_CHANGES / REJECTED.',
    '- Individual findings with file paths and line numbers.',
    '- Severity: critical / major / minor / nit.',
    '- Suggestions for fixes where applicable.',
    '',
    'You CANNOT modify files. Report findings clearly.',
  ].join('\n'),
};

export const testerAgent: BuiltInAgentDefinition = {
  agentType: 'tester',
  source: 'built-in',
  baseDir: 'built-in',
  whenToUse:
    'Test specialist. Writes and runs tests to verify implementation correctness.',
  tools: ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web-fetch', 'web-search'],
  disallowedTools: ['Agent', 'NotebookEdit'],
  model: 'sonnet',
  maxTurns: 20,
  contextBudget: 100_000,
  color: 'cyan',
  getSystemPrompt: () => [
    'You are a tester worker agent in a coordinator-led team.',
    'Your job is to write and run tests to verify correctness.',
    '',
    'Guidelines:',
    '- Write tests that actually exercise the code, not just mock everything.',
    '- Cover happy path, edge cases, error conditions.',
    '- Run the test suite and report results.',
    '- If tests fail, report the exact failures with reproduction steps.',
    '- Match the project\'s existing test framework and conventions.',
    '',
    'Be thorough. The implementation is only as good as its test coverage.',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/** All coordinator mode agent definitions. */
export function getCoordinatorAgents(): BuiltInAgentDefinition[] {
  return [
    coordinatorAgent,
    researcherAgent,
    implementerAgent,
    reviewerAgent,
    testerAgent,
  ];
}
