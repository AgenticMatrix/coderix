import type { ToolExecutor } from '../types.js';

export const execute: ToolExecutor = async (input, opts) => {
  const duration = Math.max(1, Math.min((input.duration as number) || 5, 300));
  const reason = (input.reason as string) || 'waiting for background tasks';
  const ms = duration * 1000;
  const start = Date.now();

  // Fragment sleep — check every 500ms whether notifications arrived or
  // all agents finished, so we can wake early and let the main agent
  // process results in the same turn.
  const CHECK_INTERVAL = 500;
  let elapsed = 0;
  while (elapsed < ms) {
    await new Promise(r => setTimeout(r, Math.min(CHECK_INTERVAL, ms - elapsed)));
    elapsed += CHECK_INTERVAL;

    const registry = opts.agentSpawn?.subAgentRegistry;
    if (registry) {
      // Wake if a notification arrived
      if (registry.drainNotifications().length > 0) break;

      // Wake if all agents have reached a terminal state
      const allDone = registry.list().every(a => a.status !== 'running');
      if (allDone) break;
    }
  }

  const actualDuration = (Date.now() - start) / 1000;

  return {
    content: `Slept for ${actualDuration.toFixed(1)}s. Reason: ${reason}${actualDuration < duration * 0.9 ? ' (woke early)' : ''}`,
    isError: false,
    duration: Date.now() - start,
    metadata: { reason, requestedDuration: duration, actualDuration },
  };
};
