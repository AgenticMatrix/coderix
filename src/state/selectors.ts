/**
 * Domain-specific selectors for AppState slices.
 *
 * Use these with useAppState() for fine-grained React subscriptions.
 * e.g.: const tasks = useAppState(selectRunningBackgroundTasks);
 */
import type { AppState } from './AppState.js';
import type { TrackedTask } from '../tasks/task-tracker.js';
import type { SubAgentRecord } from '../core/subagent-registry.js';

// ── Background tasks (bash run_in_background + background agents) ─────

export const selectAllBackgroundTasks = (s: AppState): TrackedTask[] =>
  Object.values(s.backgroundTasks);

export const selectBackgroundTask = (taskId: string) =>
  (s: AppState): TrackedTask | undefined => s.backgroundTasks[taskId];

export const selectRunningBackgroundTasks = (s: AppState): TrackedTask[] =>
  Object.values(s.backgroundTasks).filter(t => t.status === 'running');

// ── Sub-agents ────────────────────────────────────────────────────────

export const selectAllAgents = (s: AppState): SubAgentRecord[] =>
  Object.values(s.agents);

export const selectAgent = (agentId: string) =>
  (s: AppState): SubAgentRecord | undefined => s.agents[agentId];

export const selectRunningAgents = (s: AppState): SubAgentRecord[] =>
  Object.values(s.agents).filter(a => a.status === 'running');
