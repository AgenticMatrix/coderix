import { useEffect } from 'react';
import { onSessionTitleUpdated } from '../ipc-client.js';
import { useSessionStore } from '../store/sessionStore.js';

/**
 * useSessionTitleEvents — subscribes to the preload `session:titleUpdated`
 * channel and patches the matching session in place. The fallback arrives
 * immediately; provider refinement may arrive mid-turn or after it.
 *
 * Call once at the App root (alongside `useAgentEvents`).
 */
export function useSessionTitleEvents(): void {
  const applyTitleUpdate = useSessionStore((s) => s.applyTitleUpdate);

  useEffect(() => {
    return onSessionTitleUpdated((update) => {
      applyTitleUpdate(update.sessionId, update.title, update.source);
    });
  }, [applyTitleUpdate]);
}
