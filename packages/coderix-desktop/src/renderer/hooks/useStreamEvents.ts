import { useEffect } from 'react';
import { useStreamStore } from '../store/streamStore.js';

/**
 * useStreamEvents — subscribes to preload IPC stream events and updates
 * the stream store in real-time.
 *
 * Usage:
 *   Call this hook once at the App root level. It registers all IPC
 *   listeners and cleans them up on unmount.
 *
 *   ```tsx
 *   function App() {
 *     useStreamEvents();
 *     // ...
 *   }
 *   ```
 *
 * Under the hood, it calls `streamStore.startListening()` on mount and
 * `streamStore.stopListening()` on unmount. The stream store handles
 * all the logic of accumulating blocks, committing messages, and
 * aggregating token usage.
 */
export function useStreamEvents(): void {
  const startListening = useStreamStore((s) => s.startListening);
  const stopListening = useStreamStore((s) => s.stopListening);

  useEffect(() => {
    startListening();

    return () => {
      stopListening();
    };
  }, [startListening, stopListening]);
}
