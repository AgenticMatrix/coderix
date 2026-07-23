import type { ToolExecutor } from '../types.js';
import { listTasks as listTrackedTasks, hasPendingTaskNotifications } from '../../tasks/task-tracker.js';

export const execute: ToolExecutor = async (input, opts) => {
  const duration = Math.max(1, Math.min((input.duration as number) || 5, 300));
  const reason = (input.reason as string) || '';
  const ms = duration * 1000;
  const start = Date.now();
  const registry = opts.agentSpawn?.subAgentRegistry;

  // Count running background tasks across both sub-agents and bash tasks.
  const countRunning = (): { agents: number; bash: number } => {
    const agents = registry
      ? registry.list().filter(a => a.status === 'running').length
      : 0;
    const bash = listTrackedTasks().filter(
      t => t.type === 'bash' && t.status === 'running',
    ).length;
    return { agents, bash };
  };

  // Fragment listen — check every 500ms whether notifications arrived or
  // all background tasks finished, so we can wake early and let the main
  // agent process results in the same turn.
  const CHECK_INTERVAL = 500;
  let elapsed = 0;
  while (elapsed < ms) {
    await new Promise(r => setTimeout(r, Math.min(CHECK_INTERVAL, ms - elapsed)));
    elapsed += CHECK_INTERVAL;

    // Wake if a sub-agent or bash task notification arrived.
    // Use non-destructive checks — the main agent loop drains
    // notifications later to inject them into the conversation.
    if (registry && registry.hasPendingNotifications()) break;
    if (hasPendingTaskNotifications()) break;

    // Wake only if there were tracked tasks and all have finished.
    // Without the "had any" check, an empty registry (no background work)
    // would trip .every() and exit immediately.
    const { agents, bash } = countRunning();
    const hadAgents = registry ? registry.list().length > 0 : false;
    const hadBash = listTrackedTasks().length > 0;
    if (agents === 0 && bash === 0 && (hadAgents || hadBash)) break;
  }

  const actualDuration = (Date.now() - start) / 1000;
  const wokeEarly = actualDuration < duration * 0.9;

  const { agents: runningAgents, bash: runningBash } = countRunning();

  const reasonSuffix = reason ? ` ${reason}` : '';
  let content: string;
  if (wokeEarly) {
    let what: string;
    if (runningAgents > 0 && runningBash > 0) what = 'sub-agent and bash task';
    else if (runningBash > 0) what = 'bash task';
    else if (runningAgents > 0) what = 'sub-agent';
    else what = 'background task';
    content = `Listened for ${actualDuration.toFixed(1)}s. ${what} completed${reasonSuffix}`;
  } else {
    let stillRunning: string;
    if (runningAgents > 0 && runningBash > 0) stillRunning = 'sub-agent and bash still running';
    else if (runningBash > 0) stillRunning = 'bash still running';
    else if (runningAgents > 0) stillRunning = 'sub-agent still running';
    else stillRunning = 'still running';
    content = `Listened for ${actualDuration.toFixed(1)}s. Timed out after ${duration}s, ${stillRunning}${reasonSuffix}`;
  }

  return {
    content,
    isError: false,
    duration: Date.now() - start,
    metadata: { reason, requestedDuration: duration, actualDuration, wokeEarly },
  };
};
