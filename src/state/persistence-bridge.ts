/**
 * Persistence bridge — subscribes to AppState changes and persists
 * relevant slices to disk with debounce.
 *
 * Modeled after claude-code-best's approach: the bridge is an external
 * subscriber to the store, not a React component.  It calls the existing
 * low-level I/O functions in cli/history.ts, cli/config.ts, etc.
 */
import type { Store } from './store.js';
import type { AppState } from './AppState.js';
import { loadHistory, saveHistory } from '../cli/history.js';

const HISTORY_DEBOUNCE_MS = 2000;

/**
 * Load persisted state into the AppState store at startup.
 */
export function hydrateStore(store: Store<AppState>): void {
  const history = loadHistory();
  store.setState({ history });
}

/**
 * Subscribe to AppState changes and persist slices to disk.
 * Returns an unsubscribe function.
 */
export function attachPersistence(store: Store<AppState>): () => void {
  let lastHistoryLen = store.getState().history.length;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const unsub = store.subscribe((state) => {
    // ── History persistence ────────────────────────────────
    const len = state.history.length;
    if (len !== lastHistoryLen) {
      lastHistoryLen = len;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        saveHistory(state.history);
      }, HISTORY_DEBOUNCE_MS);
    }
  });

  return () => {
    unsub();
    if (timer !== null) clearTimeout(timer);
  };
}
