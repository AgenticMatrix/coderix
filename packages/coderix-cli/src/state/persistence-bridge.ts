/**
 * Persistence bridge — subscribes to AppState changes and persists
 * relevant slices to disk with debounce.
 *
 * The bridge is an external subscriber to the store, not a React component.
 * It calls the existing low-level I/O functions in cli/history.ts and
 * cli/config.ts.
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
  let lastHistory = store.getState().history;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const unsub = store.subscribe((state) => {
    // ── History persistence ────────────────────────────────
    if (state.history !== lastHistory) {
      lastHistory = state.history;
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
