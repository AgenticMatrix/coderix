import React, { createContext, useContext, useCallback, useSyncExternalStore } from 'react';

import type { AppState } from './AppState.js';
import type { Store } from './store.js';

const AppStoreContext = createContext<Store<AppState> | null>(null);

export function AppStateProvider({
  store,
  children,
}: {
  store: Store<AppState>;
  children: React.ReactNode;
}) {
  return <AppStoreContext.Provider value={store}>{children}</AppStoreContext.Provider>;
}

function useAppStore(): Store<AppState> {
  const store = useContext(AppStoreContext);
  if (!store) {
    throw new Error('useAppState/useSetAppState must be called within <AppStateProvider>');
  }
  return store;
}

/**
 * Subscribe to a slice of AppState. Only re-renders when the selected value
 * changes (compared via Object.is).
 *
 * For multiple independent fields, call the hook multiple times:
 *   const messages = useAppState(s => s.messages);
 *   const isStreaming = useAppState(s => s.isStreaming);
 *
 * Do NOT return new objects from the selector — Object.is will always see
 * them as changed.
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  );
}

/**
 * Get setAppState without subscribing to any state. Returns a stable
 * reference — components using only this hook never re-render from state
 * changes.
 */
export function useSetAppState(): (partial: Partial<AppState>) => void {
  const store = useAppStore();
  return useCallback((partial) => store.setState(partial), [store]);
}

/**
 * Get the raw store for passing to non-React code (tools, agents).
 */
export function useAppStoreInstance(): Store<AppState> {
  return useAppStore();
}
