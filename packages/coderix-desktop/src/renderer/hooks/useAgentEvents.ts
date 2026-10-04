import { useEffect } from 'react';
import { onAgentEvent } from '../ipc-client.js';
import { useSubagentStore } from '../store/subagentStore.js';

/**
 * useAgentEvents — subscribes to the preload `agent:update` IPC channel and
 * feeds sub-agent lifecycle events into the sub-agent store.
 *
 * Call once at the App root (alongside `useStreamEvents`).
 */
export function useAgentEvents(): void {
  const applyEvent = useSubagentStore((s) => s.applyEvent);

  useEffect(() => {
    return onAgentEvent((event) => {
      applyEvent(event.type, event.agentId, event.agent);
    });
  }, [applyEvent]);
}
